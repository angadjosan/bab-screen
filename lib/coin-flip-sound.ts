// Coin flip sound. The page plays the two sounds itself (app/CoinFlip.tsx, public/sounds/*.mp3) and
// sends the cues here as its animation reaches them, so that Spotify is turned down while the coin
// is in the air. That goes through the Web API volume control of whichever device is playing
// (lib/spotify.ts, scope user-modify-playback-state), so it works wherever the server runs. With no
// Spotify login, or a device without volume control, nothing is turned down and the cue is a no-op.

import { inBackground } from "./jobs";
import { playerVolume, setPlayerVolume } from "./spotify";
import { readJson, writeJson } from "./store";

export const CUES = ["start", "toss", "land"] as const;
export type Cue = (typeof CUES)[number];

/** Spotify's volume during the flip, as a share of what it was. */
const DUCKED = .2;
/** Spotify comes back this long after the landing, or after the flip starts if no landing follows. */
const RESTORE_AFTER_LAND_MS = 3_600;
const RESTORE_AT_MOST_MS = 30_000;
/** A second page showing the same flip sends the same cues; they are ignored. */
const REPEAT_MS = 4_000;
const FILE = "coin-flip-duck.json";

type Duck = {
  /** Spotify's volume before it was turned down; null while it is not. */
  volume: number | null;
  /** When it goes back up. */
  restoreAt: number | null;
  last: Partial<Record<Cue, number>>;
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

async function load(): Promise<Duck> {
  const saved = await readJson<Duck>(FILE);
  return { volume: typeof saved?.volume === "number" ? saved.volume : null, restoreAt: saved?.restoreAt ?? null, last: saved?.last ?? {} };
}

/** Puts the volume back at `at`, unless a later cue has moved the time on by then. */
async function restoreAt(at: number): Promise<void> {
  await pause(at - Date.now());
  const state = await load();
  if (state.volume === null || state.restoreAt === null || state.restoreAt > Date.now() + 50) return;
  const volume = state.volume;
  await writeJson(FILE, { ...state, volume: null, restoreAt: null } satisfies Duck);
  await setPlayerVolume(volume).catch(() => undefined);
}

export async function coinFlipCue(cue: Cue): Promise<void> {
  const state = await load();
  const now = Date.now();
  if (now - (state.last[cue] ?? 0) < REPEAT_MS) return;
  state.last[cue] = now;
  if (cue === "land") {
    state.restoreAt = now + RESTORE_AFTER_LAND_MS;
  } else {
    if (state.volume === null) {
      const volume = await playerVolume().catch(() => null);
      if (volume !== null && volume > 0) {
        state.volume = volume;
        await setPlayerVolume(volume * DUCKED).catch(() => {
          state.volume = null;
        });
      }
    }
    state.restoreAt = now + RESTORE_AT_MOST_MS;
  }
  await writeJson(FILE, state);
  // Kept alive after the reply on Vercel (the sound route allows 60 s).
  if (state.volume !== null) inBackground(restoreAt(state.restoreAt));
}
