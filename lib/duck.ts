// Turns Spotify on this Mac down while something else is heard (Worm talking, the coin flip's sounds, the Slack
// agent saying something in the room) and back up after, through its AppleScript dictionary. If Spotify is not
// running nothing is sent to it.
//
// One duck at a time per process: a second duck() while already ducked only extends the safety timer, and
// restore() brings back the volume read before the first one. Every volume change runs in order, so a duck that
// starts while a restore is still fading back up waits for it, and never saves a half-restored volume as the one
// to come back to (which left the music stuck quiet).

import { execFile } from "node:child_process";

/** Spotify's volume while ducked, as a share of what it was. */
const DUCKED = 0.25;
const FADE = [0.7, 0.45, 0.3, DUCKED];
/** Spotify comes back by itself this long after a duck, whatever happens to the caller. */
export const DUCK_AT_MOST_MS = 30_000;

type DuckState = { volume: number | null; timer?: NodeJS.Timeout; ops: Promise<void> };
const shared = globalThis as { __babDuck?: DuckState };
const state = (shared.__babDuck ??= { volume: null, ops: Promise.resolve() });
state.ops ??= Promise.resolve();

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

/** Runs `op` after every volume change already asked for. */
function inOrder(op: () => Promise<void>): Promise<void> {
  state.ops = state.ops.then(op, op);
  return state.ops;
}

async function fade(from: number, steps: number[]) {
  for (const share of steps) await spotify(`set sound volume to ${Math.round(from * share)}`);
}

export function restore(): Promise<void> {
  clearTimeout(state.timer);
  return inOrder(async () => {
    const volume = state.volume;
    if (volume === null) return;
    await fade(volume, [...FADE].reverse().slice(1).concat(1));
    state.volume = null;
  });
}

/** Restores after `ms` instead of whenever the safety timer would have. */
export function restoreAfter(ms: number) {
  clearTimeout(state.timer);
  state.timer = setTimeout(() => void restore(), ms);
}

/** Fades Spotify down. `atMostMs` is how long it may stay down if restore() is never called. */
export function duck(atMostMs = DUCK_AT_MOST_MS): Promise<void> {
  restoreAfter(atMostMs);
  return inOrder(async () => {
    if (state.volume !== null) return;
    const volume = Number((await spotify("get sound volume")) || NaN);
    if (!Number.isFinite(volume) || volume <= 0) return;
    state.volume = volume;
    await fade(volume, FADE);
  });
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

/** Sets the volume someone asked for: the one to come back to while ducked, otherwise right away. */
export function setVolume(volume: number): Promise<void> {
  const target = Math.max(0, Math.min(100, Math.round(volume)));
  return inOrder(async () => {
    if (!setRestoreVolume(target)) await spotify(`set sound volume to ${target}`);
  });
}

/** The volume as someone in the room would describe it: the one to come back to while ducked. */
export async function currentVolume(): Promise<number | null> {
  await state.ops;
  if (state.volume !== null) return state.volume;
  const volume = Number(await spotify("get sound volume"));
  return Number.isFinite(volume) ? volume : null;
}
