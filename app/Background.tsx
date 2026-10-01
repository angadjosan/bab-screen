"use client";

import { useEffect, useRef } from "react";
import { sunAt } from "@/lib/sun";
import { LIGHTNESS, MAX_LUMINANCE, wavePalette } from "@/lib/wave-palette";
import styles from "./Background.module.css";

/** One full drift, after which every ribbon is exactly where it started. Each motion term is a whole number of turns per loop, so there is no seam. */
const LOOP_SECONDS = 240;
/** The waves move a few pixels a frame at most, so half the display rate is plenty and halves the GPU's work. */
const FRAME_MS = 1000 / 30;
/** The canvas is drawn at this fraction of the window's CSS size and stretched; the shapes are all soft, so nothing is lost. */
const RESOLUTION = 0.5;
const MAX_WIDTH = 1280;
/** Where the loop stands for the still frame shown under prefers-reduced-motion. */
const STILL_PHASE = 1.9;
/**
 * How often the ribbons' colours are brought up to date with the sun (lib/wave-palette.ts). The palette moves
 * slowly enough that each refresh is a change of less than one 8-bit level, so the drift has no visible steps; it
 * costs two uniforms and five CSS properties, and nothing per frame.
 */
const PALETTE_MS = 10_000;

/**
 * A way to hold the palette at one moment instead of following the sun. It is null, so the palette follows the
 * real time. Set it to an instant, written with its UTC offset so the computer's time zone cannot move it (for
 * example "2026-10-01T08:00:00-07:00", a morning look), and the colours stay at that moment's at every time and
 * date; the ribbons drift as usual. Nothing else needs to change either way.
 */
const PINNED_TIME: string | null = null;

/**
 * The clock the palette reads. It is the real clock, or the pinned instant above when one is set, unless the
 * address asks for a preview, which always wins:
 *   ?time=17:30             holds that time today (the computer's time zone)
 *   ?time=2026-12-21T17:30  holds that date and time, to see another season
 *   ?day=120                runs a whole day every 120 seconds, starting from ?time if given, otherwise from now
 */
function paletteClock(search: string): { now: () => Date; refreshMs: number } {
  const params = new URLSearchParams(search);
  const time = params.get("time") ?? "";
  const hoursMinutes = /^(\d{1,2}):(\d{2})$/.exec(time);
  const asked = hoursMinutes ? new Date().setHours(Number(hoursMinutes[1]), Number(hoursMinutes[2]), 0, 0) : new Date(time).getTime();
  const pinned = PINNED_TIME === null ? null : new Date(PINNED_TIME).getTime();
  const held = time && Number.isFinite(asked) ? asked : null;
  const daySeconds = Number(params.get("day"));
  if (daySeconds > 0) {
    const opened = Date.now();
    return { now: () => new Date((held ?? opened) + (Date.now() - opened) * (86_400 / daySeconds)), refreshMs: FRAME_MS };
  }
  const fixed = held ?? pinned;
  return { now: () => (fixed === null ? new Date() : new Date(fixed)), refreshMs: PALETTE_MS };
}

const VERTEX = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";

// Five soft ribbons of light on the brand's black.
const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uPhase;
uniform float uLight;
uniform float uMaxY;
uniform vec2 uAB[5];

float hash(vec2 q) {
  vec3 r = fract(vec3(q.xyx) * 0.1031);
  r += dot(r, r.yzx + 33.33);
  return fract((r.x + r.y) * r.z);
}

// One ribbon: a crest that wanders as two sines, soft above it and trailing a long veil below, like a fold of silk.
float ribbon(vec2 p, float y0, float f1, float k1, float ph1, float f2, float k2, float ph2, float w, float k3) {
  float crest = y0 + 0.11 * sin(p.x * f1 + k1 * uPhase + ph1) + 0.06 * sin(p.x * f2 + k2 * uPhase + ph2);
  float d = p.y - crest;
  float along = 0.6 + 0.4 * sin(p.x * 0.8 - k3 * uPhase + ph1);
  float core = exp(-d * d / (w * w));
  float veil = d < 0.0 ? exp(d / (w * 5.0)) : core;
  return along * (0.5 * core + 0.6 * veil);
}

// OKLab to linear sRGB (Ottosson).
vec3 oklab(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  p = mat2(0.95, 0.31, -0.31, 0.95) * p;
  p.y += 0.05 * sin(p.x * 1.7 + 2.0 * uPhase) + 0.03 * sin(p.x * 3.9 - 3.0 * uPhase + 1.7);

  float w0 = ribbon(p, 0.52, 1.2, -2.0, 5.6, 3.1, 1.0, 2.9, 0.040, -2.0);
  float w1 = ribbon(p, 0.27, 2.3, 2.0, 4.4, 1.6, -1.0, 0.7, 0.045, 2.0);
  float w2 = ribbon(p, 0.02, 1.4, -1.0, 2.1, 2.9, 2.0, 4.0, 0.050, -1.0);
  float w3 = ribbon(p, -0.24, 1.9, 1.0, 0.0, 3.7, -2.0, 1.3, 0.035, 1.0);
  float w4 = ribbon(p, -0.50, 1.6, -1.0, 3.3, 2.6, 3.0, 5.1, 0.045, -1.0);
  float total = w0 + w1 + w2 + w3 + w4;

  // Hue and chroma: the ribbons' colours averaged by how much of each is here. Lightness and chroma both rise
  // from the black canvas (0.154, no chroma) towards the ceiling as the light adds up, and level off there.
  vec2 ab = (w0 * uAB[0] + w1 * uAB[1] + w2 * uAB[2] + w3 * uAB[3] + w4 * uAB[4]) / max(total, 1e-4);
  float amount = 1.0 - exp(-1.5 * total);
  vec3 rgb = max(oklab(vec3(mix(0.154, uLight, amount), ab * amount)), 0.0);
  rgb *= min(1.0, uMaxY / max(dot(rgb, vec3(0.2126, 0.7152, 0.0722)), 1e-6));

  // To sRGB, with a little grain so the dark gradients do not band on an 8-bit panel.
  vec3 colour = mix(12.92 * rgb, 1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
  float grain = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 71.7) - 1.0;
  gl_FragColor = vec4(colour + grain * 1.5 / 255.0, 1.0);
}`;

/**
 * The page's ambient background: slow ribbons of colour drifting across the brand's black, their colours following
 * the daylight outside (lib/wave-palette.ts). Decorative only.
 * One small WebGL canvas behind everything, mounted once in layout.tsx. Until it has drawn, and wherever WebGL is
 * missing or its context is lost, the still gradient painted by Background.module.css stands in for it.
 */
export function Background() {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const layer = root.current;
    if (!el || !layer) return;
    const clock = paletteClock(window.location.search);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let gl: WebGLRenderingContext | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uPhase: WebGLUniformLocation | null = null;
    let uLight: WebGLUniformLocation | null = null;
    let uAB: WebGLUniformLocation | null = null;
    let frame = 0;
    let lastDrawn = -Infinity;

    const setup = () => {
      gl = el.getContext("webgl", { alpha: false, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
      if (!gl) return false;
      const program = gl.createProgram();
      for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
        const shader = gl.createShader(type);
        if (!shader || !program) return false;
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return false;
        gl.attachShader(program, shader);
      }
      if (!program) return false;
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return false;
      gl.useProgram(program);
      // One triangle that covers the whole canvas.
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(program, "p");
      gl.enableVertexAttribArray(position);
      gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(program, "uRes");
      uPhase = gl.getUniformLocation(program, "uPhase");
      uLight = gl.getUniformLocation(program, "uLight");
      uAB = gl.getUniformLocation(program, "uAB");
      gl.uniform1f(gl.getUniformLocation(program, "uMaxY"), MAX_LUMINANCE);
      return true;
    };

    // The colours for the sun's position now: to the shader as uniforms, and to the still gradient in the
    // stylesheet as custom properties, so that whatever stands in for the canvas is in the same palette.
    const colour = () => {
      const palette = wavePalette(sunAt(clock.now()));
      // LIGHTNESS is the ceiling; a palette may sit under it but is never let over.
      const lightness = Math.min(palette.lightness, LIGHTNESS);
      palette.ribbons.forEach(({ hue, chroma }, i) => {
        layer.style.setProperty(`--wave-${i}`, `oklch(${lightness.toFixed(4)} ${chroma.toFixed(4)} ${hue.toFixed(2)})`);
      });
      if (!gl || gl.isContextLost()) return;
      gl.uniform1f(uLight, lightness);
      gl.uniform2fv(uAB, palette.ribbons.flatMap(({ hue, chroma }) => [chroma * Math.cos((hue * Math.PI) / 180), chroma * Math.sin((hue * Math.PI) / 180)]));
    };

    const resize = () => {
      const scale = Math.min(RESOLUTION, MAX_WIDTH / Math.max(1, window.innerWidth));
      const width = Math.max(1, Math.round(window.innerWidth * scale));
      const height = Math.max(1, Math.round(window.innerHeight * scale));
      if (el.width !== width || el.height !== height) { el.width = width; el.height = height; }
    };

    const draw = (phase: number) => {
      if (!gl) return;
      gl.viewport(0, 0, el.width, el.height);
      gl.uniform2f(uRes, el.width, el.height);
      gl.uniform1f(uPhase, phase);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      el.setAttribute("data-drawn", "");
    };

    const tick = (now: number) => {
      frame = window.requestAnimationFrame(tick);
      if (now - lastDrawn < FRAME_MS - 2) return;
      lastDrawn = now;
      // The clock wraps with the loop, so the phase never grows and never loses precision.
      draw(((now / 1000) % LOOP_SECONDS) / LOOP_SECONDS * 2 * Math.PI);
    };

    // (Re)start in whatever state the page is in: still for reduced motion, stopped while hidden, running otherwise.
    const start = () => {
      window.cancelAnimationFrame(frame);
      colour();
      if (!gl || gl.isContextLost()) return;
      resize();
      if (reduced.matches) draw(STILL_PHASE);
      else if (!document.hidden) { lastDrawn = -Infinity; frame = window.requestAnimationFrame(tick); }
    };

    const onLost = (event: Event) => {
      event.preventDefault();
      window.cancelAnimationFrame(frame);
      el.removeAttribute("data-drawn");
    };
    const onRestored = () => { if (setup()) start(); };

    el.addEventListener("webglcontextlost", onLost);
    el.addEventListener("webglcontextrestored", onRestored);
    window.addEventListener("resize", start);
    document.addEventListener("visibilitychange", start);
    reduced.addEventListener("change", start);
    if (setup()) start();
    else colour();
    // Under reduced motion nothing else redraws, so the still frame is redrawn in the new colours: the shapes stay
    // put and only the palette drifts, too slowly to see.
    const refresh = window.setInterval(() => {
      colour();
      if (reduced.matches && !document.hidden) draw(STILL_PHASE);
    }, clock.refreshMs);

    return () => {
      window.clearInterval(refresh);
      window.cancelAnimationFrame(frame);
      el.removeEventListener("webglcontextlost", onLost);
      el.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", start);
      reduced.removeEventListener("change", start);
    };
  }, []);

  return (
    <div ref={root} className={styles.root} aria-hidden="true">
      <canvas ref={canvas} className={styles.waves} />
    </div>
  );
}
