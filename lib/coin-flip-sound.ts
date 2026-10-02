// Coin flip sound, played on this Mac with afplay so no browser autoplay permission is needed, and Spotify turned
// down while it plays. The page sends the cues as its animation reaches them (app/CoinFlip.tsx).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

export const CUES = ["start", "toss", "land"] as const;
export type Cue = (typeof CUES)[number];

const SOUNDS: Partial<Record<Cue, string>> = { toss: "coin-flip-toss.mp3", land: "coin-flip-land.mp3" };
/** Spotify's volume during the flip, as a share of what it was. */
const DUCKED = .2;
const FADE = [.7, .45, .3, DUCKED];
/** Spotify comes back this long after the landing sound starts, or after the flip starts if no landing follows. */
const RESTORE_AFTER_LAND_MS = 3_600;
const RESTORE_AT_MOST_MS = 30_000;
/** A second page showing the same flip sends the same cues; they are ignored. */
const REPEAT_MS = 4_000;

const shared = globalThis as { coinFlipSound?: { volume: number | null; timer?: NodeJS.Timeout; playing?: ChildProcess; last: Partial<Record<Cue, number>> } };
const state = (shared.coinFlipSound ??= { volume: null, last: {} });

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

async function fade(from: number, steps: number[]) {
  for (const share of steps) await spotify(`set sound volume to ${Math.round(from * share)}`);
}

async function restore() {
  clearTimeout(state.timer);
  const volume = state.volume;
  if (volume === null) return;
  state.volume = null;
  await fade(volume, [...FADE].reverse().slice(1).concat(1));
}

async function duck() {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void restore(), RESTORE_AT_MOST_MS);
  if (state.volume !== null) return;
  const volume = Number(await spotify("get sound volume") || NaN);
  if (!Number.isFinite(volume) || state.volume !== null) return;
  state.volume = volume;
  await fade(volume, FADE);
}

function play(file: string) {
  state.playing?.kill();
  const child = spawn("afplay", [path.join(process.cwd(), "public", "sounds", file)], { stdio: "ignore" });
  child.on("error", () => {});
  state.playing = child;
}

export async function coinFlipCue(cue: Cue) {
  const now = Date.now();
  if (now - (state.last[cue] ?? 0) < REPEAT_MS) return;
  state.last[cue] = now;
  const sound = SOUNDS[cue];
  if (sound) play(sound);
  if (cue !== "land") return duck();
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void restore(), RESTORE_AFTER_LAND_MS);
}
