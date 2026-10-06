"use client";

import { useEffect, useRef } from "react";
import { sunAt } from "@/lib/sun";
import { wavePalette } from "@/lib/wave-palette";
import { BANDS, createLevelTracker } from "./edge-glow-levels";
import styles from "./EdgeGlow.module.css";

/** The glow is soft everywhere but its core line, so half the window's resolution is plenty. */
const RESOLUTION = 0.5;
const MAX_WIDTH = 1280;
const PALETTE_MS = 10_000;
/** How quickly the whole glow fades in when the stream starts and out when it stops, per 1/60 s. */
const PRESENCE_RATE = 0.04;
/** The ribbons' own chroma is kept low so text can sit on them; the glow is light, so it is let further. */
const CHROMA_BOOST = 1.7;
const MAX_CHROMA = 0.19;

const VERTEX = "attribute vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }";

/*
 * Light along the bottom edge of the screen, rising a little way up both sides, in the background ribbons' colours.
 * How far it reaches into the screen at each point is the music: bass in the middle, treble towards the corners,
 * mirrored, so the bottom edge reads as one waveform. Colours drift slowly along the edge, as Siri's do.
 */
const FRAGMENT = `
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uEnergy;
uniform float uPresence;
uniform sampler2D uLevels;
uniform vec2 uAB[6];

float hash(vec2 q) {
  vec3 r = fract(vec3(q.xyx) * 0.1031);
  r += dot(r, r.yzx + 33.33);
  return fract((r.x + r.y) * r.z);
}

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

float level(float u) {
  return texture2D(uLevels, vec2(mix(0.5, ${BANDS}.0 - 0.5, u) / ${BANDS}.0, 0.5)).r;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  float w = uRes.x;
  float h = uRes.y;
  float fromCentre = abs(px.x / w - 0.5) * 2.0;
  float swell = 0.9 + 0.1 * sin(px.x / w * 11.0 - uTime * 1.7);

  // Quiet: a resting line about 13px deep. A loud band reaches about 170px into the stage.
  float reach = h * (0.012 + 0.13 * level(fromCentre) * swell + 0.018 * uEnergy);
  // Steeper than a plain exponential, so the light has an outline that reads as a wave instead of a haze.
  float bottom = exp(-pow(px.y / reach, 1.4));

  float edge = min(px.x, w - px.x);
  float rise = 1.0 - smoothstep(0.0, h * 0.55, px.y);
  float sideReach = h * (0.008 + 0.05 * level(1.0) + 0.015 * uEnergy) * rise;
  float sides = exp(-pow(edge / max(sideReach, 1e-3), 1.4)) * rise;

  float glow = max(bottom, sides);
  float core = exp(-min(px.y, edge + (1.0 - rise) * h) / (h * 0.0035)) * (0.35 + 0.65 * uEnergy);

  // Colour drifts along the edge: the six entries are the five ribbons and the first again, so it wraps cleanly.
  float t = fract(px.x / w * 0.9 + px.y / h * 0.4 - uTime * 0.02) * 5.0;
  vec2 ab = vec2(0.0);
  for (int i = 0; i < 6; i++) ab += max(0.0, 1.0 - abs(t - float(i))) * uAB[i];

  // Bright only close to the edge, in the stage's bottom margin; further in, where the stage's text is, the light
  // dims fast (lightness falls with the cube of the glow), so the text keeps its contrast over it.
  float alpha = clamp(glow + core, 0.0, 1.0) * uPresence;
  float lightness = mix(mix(0.3, 0.78, glow * glow * glow), 0.93, clamp(core, 0.0, 1.0));
  vec3 rgb = max(oklab(vec3(lightness, ab)), 0.0);
  vec3 colour = mix(12.92 * rgb, 1.055 * pow(rgb, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, rgb));
  float grain = (hash(px) + hash(px + 71.7) - 1.0) * 1.5 / 255.0;
  gl_FragColor = vec4((colour + grain) * alpha, alpha);
}`;

type Renderer = {
  draw: (time: number, energy: number, presence: number, levels: Uint8Array) => void;
  resize: () => void;
  setColours: (ab: number[]) => void;
};

function compileProgram(gl: WebGLRenderingContext): WebGLProgram | null {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, FRAGMENT]] as const) {
    const shader = gl.createShader(type);
    if (!shader || !program) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return null;
    gl.attachShader(program, shader);
  }
  if (!program) return null;
  gl.linkProgram(program);
  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : null;
}

/** The band levels as a 32x1 texture, so the shader interpolates between bands for free. */
function createLevelTexture(gl: WebGLRenderingContext) {
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, BANDS, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, new Uint8Array(BANDS));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  const program = gl && compileProgram(gl);
  if (!gl || !program) return null;
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "p");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  createLevelTexture(gl);
  const at = (name: string) => gl.getUniformLocation(program, name);
  const uniforms = { res: at("uRes"), time: at("uTime"), energy: at("uEnergy"), presence: at("uPresence"), ab: at("uAB") };

  return {
    resize: () => {
      const scale = Math.min(RESOLUTION, MAX_WIDTH / Math.max(1, window.innerWidth));
      canvas.width = Math.max(1, Math.round(window.innerWidth * scale));
      canvas.height = Math.max(1, Math.round(window.innerHeight * scale));
    },
    setColours: (ab) => gl.uniform2fv(uniforms.ab, ab),
    draw: (time, energy, presence, levels) => {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(uniforms.res, canvas.width, canvas.height);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(uniforms.energy, energy);
      gl.uniform1f(uniforms.presence, presence);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BANDS, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, levels);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** The ribbons' colours for the sun's position now, as OKLab a/b pairs, brighter in chroma, the first repeated last. */
function glowColours(): number[] {
  const ribbons = wavePalette(sunAt(new Date())).ribbons;
  return [...ribbons, ribbons[0]].flatMap(({ hue, chroma }) => {
    const c = Math.min(MAX_CHROMA, chroma * CHROMA_BOOST);
    return [c * Math.cos((hue * Math.PI) / 180), c * Math.sin((hue * Math.PI) / 180)];
  });
}

/**
 * Light along the bottom edge of the screen that moves with whatever this Mac is playing (/api/audio-levels). It is
 * there only while the stream is: on a machine that cannot read its audio, or with reduced motion, nothing is drawn.
 * Mounted once in layout.tsx, between the background and the stage.
 */
export function EdgeGlow() {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!element || reduced.matches) return;
    const renderer = createRenderer(element);
    if (!renderer) return;
    const tracker = createLevelTracker();
    const stream = new EventSource("/api/audio-levels");
    stream.onmessage = (message) => tracker.push(String(message.data), performance.now());

    let frame = 0;
    let last = performance.now();
    let presence = 0;
    const tick = (now: number) => {
      frame = window.requestAnimationFrame(tick);
      const elapsed = now - last;
      last = now;
      tracker.step(elapsed, now);
      presence += ((tracker.live(now) ? 1 : 0) - presence) * Math.min(1, PRESENCE_RATE * (elapsed / (1000 / 60)));
      renderer.draw((now / 1000) % 3600, tracker.energy(), presence, tracker.levels);
    };

    const start = () => {
      window.cancelAnimationFrame(frame);
      if (document.hidden) return;
      renderer.resize();
      last = performance.now();
      frame = window.requestAnimationFrame(tick);
    };
    renderer.setColours(glowColours());
    const recolour = window.setInterval(() => renderer.setColours(glowColours()), PALETTE_MS);
    window.addEventListener("resize", start);
    document.addEventListener("visibilitychange", start);
    start();

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearInterval(recolour);
      window.removeEventListener("resize", start);
      document.removeEventListener("visibilitychange", start);
      stream.close();
    };
  }, []);

  return <canvas ref={canvas} className={styles.glow} aria-hidden="true" />;
}
