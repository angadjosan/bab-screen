// Coin flip sound, played on this Mac with afplay so no browser autoplay permission is needed, and Spotify turned
// down while it plays. The page sends the cues as its animation reaches them (app/CoinFlip.tsx).

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { duck, restoreAfter } from "./duck";

export const CUES = ["start", "toss", "land"] as const;
export type Cue = (typeof CUES)[number];

const SOUNDS: Partial<Record<Cue, string>> = { toss: "coin-flip-toss.mp3", land: "coin-flip-land.mp3" };
/** Spotify comes back this long after the landing sound starts, or after the flip starts if no landing follows. */
const RESTORE_AFTER_LAND_MS = 3_600;
const RESTORE_AT_MOST_MS = 30_000;
/** A second page showing the same flip sends the same cues; they are ignored. */
const REPEAT_MS = 4_000;

const shared = globalThis as { coinFlipSound?: { playing?: ChildProcess; last: Partial<Record<Cue, number>> } };
const state = (shared.coinFlipSound ??= { last: {} });

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
  if (cue !== "land") return duck(RESTORE_AT_MOST_MS);
  restoreAfter(RESTORE_AFTER_LAND_MS);
}
