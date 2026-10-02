"use client";

import { useEffect, useRef } from "react";

// The coin toss, drawn as flat vector art on a canvas. The coin is a rigid disc with a real orientation: it sinks
// back before the throw, turns end over end in the air about an axis that itself swings once round, comes down
// on its rim and spins there, nearly edge-on, before it falls flat. Projection is orthographic, so each face is
// an affine map of its artwork.

type Side = "heads" | "tails";
type M3 = number[];

const SIZE = 780;
const RADIUS = 150;
const THICKNESS = .15;
// Seconds: at rest, the dip before the throw, in the air, two hops (duration, height), then the spin on the rim.
const HOLD = .5;
const WINDUP = .55;
const FLIGHT = 2.6;
const HOPS = [[.24, .08], [.13, .02]];
const RATTLE = 2.4;
/** The result is called this long after the coin comes down, once the face is plain to see. */
const LANDED_AFTER = 1.7;
const SPARKLE = 2.6;
const TURNS = 9;
const LIFT = 1.1;
/** How far from flat the coin comes down: just short of standing on its edge. */
const RIM = 1.45;
const LIGHT = [-.6, -.8];
const STARS = [[-1.3, -.9, .2], [1.32, -.78, .16], [1.12, 1.08, .13], [-1.08, 1.02, .18], [.25, -1.5, .11]];

const { PI, sin, cos, min, max, hypot } = Math;
const IDENTITY: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const rotX = (a: number): M3 => [1, 0, 0, 0, cos(a), -sin(a), 0, sin(a), cos(a)];
const rotY = (a: number): M3 => [cos(a), 0, sin(a), 0, 1, 0, -sin(a), 0, cos(a)];
const rotZ = (a: number): M3 => [cos(a), -sin(a), 0, sin(a), cos(a), 0, 0, 0, 1];
const mul = (a: M3, b: M3): M3 => a.map((_, i) => a[i - i % 3] * b[i % 3] + a[i - i % 3 + 1] * b[i % 3 + 3] + a[i - i % 3 + 2] * b[i % 3 + 6]);
const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join()})`;

type Logo = { path: Path2D; minor: boolean }[];
let logo: Promise<Logo> | null = null;
const loadLogo = () => (logo ??= fetch("/bab-logo.svg").then((r) => r.text()).then((svg) => [...svg.matchAll(/<path d="([^"]+)" fill="([^"]+)"/g)].map((m) => ({ path: new Path2D(m[1]), minor: m[2] !== "#FECB33" }))));

/** Orientation and height (in radii the coin is lifted towards the viewer) at t seconds. */
function pose(t: number, tails: boolean) {
  const rest = tails ? rotX(PI) : IDENTITY;
  const launch = HOLD + WINDUP;
  if (t < launch) {
    // Slow down and back, then quickly up into the throw.
    const dip = sin(PI * (max(0, t - HOLD) / WINDUP) ** 2);
    return { R: rotX(-.32 * dip), h: -.13 * dip };
  }
  const flight = (t - launch) / FLIGHT;
  if (flight < 1) {
    const R = mul(mul(rotZ(2 * PI * flight), rotY(.4 * sin(PI * flight))), rotX((2 * PI * TURNS + (tails ? PI : 0) + RIM) * flight));
    return { R, h: 4 * LIFT * flight * (1 - flight) };
  }
  let u = t - launch - FLIGHT;
  // On the rim the lean circles round faster and faster as it dies away, like a coin spun on a table.
  const tilt = RIM * cos(PI / 2 * min(1, u / RATTLE)) ** 1.6;
  const round = 2 * PI * (1.5 * u + .9 * u * u);
  const R = mul(mul(mul(rotZ(round), rotX(tilt)), rotZ(-round)), rest);
  for (const [length, height] of HOPS) {
    if (u < length) return { R, h: 4 * height * (u / length) * (1 - u / length) };
    u -= length;
  }
  return { R, h: 0 };
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, 2 * PI);
  ctx.fillStyle = fill;
  ctx.fill();
}

function face(ctx: CanvasRenderingContext2D, tails: boolean, mark: Logo | null) {
  disc(ctx, 0, 0, 1, "#FECB33");
  ctx.beginPath();
  ctx.arc(0, 0, .89, 0, 2 * PI);
  ctx.lineWidth = .018;
  ctx.strokeStyle = "#FFE99A";
  ctx.stroke();
  disc(ctx, 0, 0, .78, "#C06C0A");
  const well = ctx.createLinearGradient(-.6, -.6, .6, .6);
  well.addColorStop(0, "#F6AE22");
  well.addColorStop(1, "#E3850E");
  ctx.save();
  ctx.clip();
  disc(ctx, .025, .035, .78, well);
  ctx.restore();
  for (const [dx, dy, main, minor] of [[.03, .04, "#B25E08", "#B25E08"], [0, 0, "#FFE27A", "#FFF4C4"]] as const) {
    ctx.save();
    ctx.translate(dx, dy);
    if (tails) {
      ctx.scale(.0105, .0105);
      ctx.font = "700 100px Inter, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = main;
      ctx.fillText("$", 0, 4);
    } else if (mark) {
      ctx.scale(.0031, .0031);
      ctx.translate(-172, -155.5);
      for (const piece of mark) {
        ctx.fillStyle = piece.minor ? minor : main;
        ctx.fill(piece.path);
      }
    }
    ctx.restore();
  }
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, turn: number) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(turn);
  ctx.beginPath();
  ctx.moveTo(0, -size);
  for (let i = 1; i <= 4; i += 1) ctx.quadraticCurveTo(0, 0, size * sin(i * PI / 2), -size * cos(i * PI / 2));
  ctx.fill();
  ctx.restore();
}

function draw(ctx: CanvasRenderingContext2D, t: number, tails: boolean, mark: Logo | null) {
  const { R, h } = pose(t, tails);
  const e1 = [R[0], R[3]];
  const e2 = [R[1], R[4]];
  const facing = R[8] >= 0 ? 1 : -1;
  const centre = SIZE / 2;

  // The outline of a thick disc: both faces, and the wall between the points where each is widest across the offset.
  const solid = (x: number, y: number, r: number, fill: string) => {
    const dx = R[2] * THICKNESS * r / 2 * facing;
    const dy = R[5] * THICKNESS * r / 2 * facing;
    ctx.fillStyle = ctx.strokeStyle = fill;
    ctx.lineWidth = 1;
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.transform(r * e1[0], r * e1[1], r * e2[0], r * e2[1], x + side * dx, y + side * dy);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, 2 * PI);
      ctx.restore();
      ctx.fill();
    }
    if (hypot(dx, dy) < .05) return [dx, dy];
    const widest = Math.atan2(e2[0] * -dy + e2[1] * dx, e1[0] * -dy + e1[1] * dx);
    const px = r * (e1[0] * cos(widest) + e2[0] * sin(widest));
    const py = r * (e1[1] * cos(widest) + e2[1] * sin(widest));
    ctx.beginPath();
    ctx.moveTo(x - dx + px, y - dy + py);
    ctx.lineTo(x + dx + px, y + dy + py);
    ctx.lineTo(x + dx - px, y + dy - py);
    ctx.lineTo(x - dx - px, y - dy - py);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    return [dx, dy];
  };

  ctx.clearRect(0, 0, SIZE, SIZE);
  const lift = max(0, h);
  solid(centre + 10 + 95 * lift, centre + 14 + 125 * lift, RADIUS * (1 + .12 * lift), "#000");

  const r = RADIUS * (1 + h);
  const y = centre - 30 * lift;
  const lean = hypot(R[2], R[5]);
  const lit = lean ? .5 - facing * (R[2] * LIGHT[0] + R[5] * LIGHT[1]) / lean / 2 : .5;
  const [dx, dy] = solid(centre, y, r, mix([169, 98, 12], [246, 178, 44], lit));

  ctx.save();
  ctx.transform(r * e1[0], r * e1[1], r * e2[0], r * e2[1], centre + dx, y + dy);
  if (facing < 0) ctx.scale(1, -1);
  face(ctx, facing < 0, mark);
  disc(ctx, 0, 0, 1, `rgba(110, 52, 0, ${(1 - Math.abs(R[8])) * .3})`);
  ctx.restore();

  const since = t - (HOLD + WINDUP + FLIGHT + LANDED_AFTER);
  if (since < 0 || since > SPARKLE) return;
  STARS.forEach(([sx, sy, size], i) => {
    const life = ((since - i * .17 + 9) % 1.2) / .6;
    if (life >= 1 || since < i * .17) return;
    ctx.fillStyle = i % 2 ? "#FFE99A" : "#FECB33";
    star(ctx, centre + sx * RADIUS, centre + sy * RADIUS, size * RADIUS * sin(PI * life), life);
  });
}

export function CoinToss({ winner, onLand }: { winner: Side; onLand: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const landed = useRef(onLand);
  landed.current = onLand;

  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    // Backing pixels match what is on screen: the stage's --fit scale times the display's pixel ratio.
    const fit = Number(getComputedStyle(document.documentElement).getPropertyValue("--fit")) || 1;
    const ratio = min(3, max(1, fit * window.devicePixelRatio));
    element.width = element.height = Math.round(SIZE * ratio);
    let mark: Logo | null = null;
    loadLogo().then((loaded) => { mark = loaded; }, () => {});
    const start = performance.now();
    let told = false;
    let frame = 0;
    const tick = () => {
      const t = (performance.now() - start) / 1000;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      draw(ctx, t, winner === "tails", mark);
      if (!told && t >= HOLD + WINDUP + FLIGHT + LANDED_AFTER) {
        told = true;
        landed.current();
      }
      if (t < HOLD + WINDUP + FLIGHT + LANDED_AFTER + SPARKLE + .1) frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [winner]);

  return <canvas ref={canvas} style={{ position: "absolute", left: "50%", top: "50%", width: SIZE, height: SIZE, transform: "translate(-50%, -50%)" }} role="img" aria-label="Coin toss" />;
}
