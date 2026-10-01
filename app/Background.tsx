"use client";

import { useEffect, useRef } from "react";
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

/*
 * Colour is worked out in OKLab, where equal steps look equal, so every ribbon is the same lightness whatever its
 * hue and two ribbons crossing blend through a clean in-between hue instead of going dark and grey.
 *
 * LIGHTNESS is the waves' ceiling (the black canvas, #0C0C0C, is 0.154). MAX_LUMINANCE is the same ceiling as
 * relative luminance, the number contrast is computed from; it is a guard, and it is the level at which the faintest
 * text on the page, the 50% white labels, still has 4.5:1 against the brightest wave. Text sits straight on the waves.
 */
const LIGHTNESS = 0.305;
const MAX_LUMINANCE = 0.0257;

/**
 * The ribbons, top of the screen to bottom, as OKLCH hue and chroma. The hues are one arc of the colour wheel:
 * indigo at 268 degrees, the exact complement of the brand's gold (88.6), then violet and plum, round to the
 * brand's burnt amber (--bab-amber-deep, 42.6). Neighbours on screen are neighbours on the arc, so their blends stay
 * clean. Each chroma is about four fifths of what sRGB can show at this lightness, which keeps the colour rich
 * without clipping.
 */
const RIBBONS = [
  { hue: 268, chroma: 0.16 },
  { hue: 298, chroma: 0.13 },
  { hue: 338, chroma: 0.105 },
  { hue: 42.6, chroma: 0.068 },
  { hue: 338, chroma: 0.105 },
];

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
 * The page's ambient background: slow ribbons of colour drifting across the brand's black. Decorative only.
 * One small WebGL canvas behind everything, mounted once in layout.tsx. Until it has drawn, and wherever WebGL is
 * missing or its context is lost, the still gradient painted by Background.module.css stands in for it.
 */
export function Background() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let gl: WebGLRenderingContext | null = null;
    let uRes: WebGLUniformLocation | null = null;
    let uPhase: WebGLUniformLocation | null = null;
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
      gl.uniform1f(gl.getUniformLocation(program, "uLight"), LIGHTNESS);
      gl.uniform1f(gl.getUniformLocation(program, "uMaxY"), MAX_LUMINANCE);
      const ab = new Float32Array(RIBBONS.flatMap(({ hue, chroma }) => [chroma * Math.cos((hue * Math.PI) / 180), chroma * Math.sin((hue * Math.PI) / 180)]));
      gl.uniform2fv(gl.getUniformLocation(program, "uAB"), ab);
      return true;
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

    return () => {
      window.cancelAnimationFrame(frame);
      el.removeEventListener("webglcontextlost", onLost);
      el.removeEventListener("webglcontextrestored", onRestored);
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", start);
      reduced.removeEventListener("change", start);
    };
  }, []);

  return (
    <div className={styles.root} aria-hidden="true">
      <canvas ref={canvas} className={styles.waves} />
    </div>
  );
}
