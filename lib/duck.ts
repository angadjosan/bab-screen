// Turns Spotify on this Mac down while something else is heard (the coin flip's sounds, Jarvis talking)
// and back up after, through its AppleScript dictionary. If Spotify is not running nothing is sent to it.
//
// One duck at a time per process: a second duck() while already ducked only extends the safety timer,
// and restore() brings back the volume read before the first one.

import { execFile } from "node:child_process";

/** Spotify's volume while ducked, as a share of what it was. */
const DUCKED = .2;
const FADE = [.7, .45, .3, DUCKED];
/** Spotify comes back by itself this long after a duck, whatever happens to the caller. */
export const DUCK_AT_MOST_MS = 30_000;

type DuckState = { volume: number | null; timer?: NodeJS.Timeout };
const shared = globalThis as { __babDuck?: DuckState };
const state = (shared.__babDuck ??= { volume: null });

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

async function fade(from: number, steps: number[]) {
  for (const share of steps) await spotify(`set sound volume to ${Math.round(from * share)}`);
}

export async function restore() {
  clearTimeout(state.timer);
  const volume = state.volume;
  if (volume === null) return;
  state.volume = null;
  await fade(volume, [...FADE].reverse().slice(1).concat(1));
}

/** Restores after `ms` instead of whenever the safety timer would have. */
export function restoreAfter(ms: number) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void restore(), ms);
}

/** Fades Spotify down. `atMostMs` is how long it may stay down if restore() is never called. */
export async function duck(atMostMs = DUCK_AT_MOST_MS) {
  restoreAfter(atMostMs);
  if (state.volume !== null) return;
  const volume = Number(await spotify("get sound volume") || NaN);
  if (!Number.isFinite(volume) || state.volume !== null) return;
  state.volume = volume;
  await fade(volume, FADE);
}

/** True while ducked. A volume change asked for meanwhile should go to setRestoreVolume, or restore() undoes it. */
export function isDucked(): boolean {
  return state.volume !== null;
}

/** While ducked, changes the volume restore() will bring back. Returns false when not ducked. */
export function setRestoreVolume(volume: number): boolean {
  if (state.volume === null) return false;
  state.volume = Math.max(0, Math.min(100, Math.round(volume)));
  return true;
}

/** The volume restore() will bring back, or null when not ducked. */
export function restoreVolume(): number | null {
  return state.volume;
}
