// Turns the raw frames from /api/audio-levels (dB, as lib/audio-levels.ts streams them) into what the edge glow
// draws: one 0..1 level per band and an overall energy, each band scaled against its own recent peak so quiet and
// loud songs, and bass-heavy and thin ones, all move the glow the same amount.

export const BANDS = 32;
/** Below this overall loudness the Mac counts as silent and the glow settles to its resting line. */
const SILENCE_DB = -70;
/** How far under its recent peak a band reads as zero. */
const RANGE_DB = 42;
/** How fast a band's remembered peak falls back when the music gets quieter, in dB per second. */
const PEAK_FALL_DB_PER_S = 3;
/** A level rises this much of the way to its target per 1/60 s, and falls this much: quick to hit, slow to fade. */
const ATTACK = 0.55;
const RELEASE = 0.12;
/** With no frame for this long, the stream counts as gone and the glow fades out. */
const STALE_MS = 3_000;
/** After this long without a sound (Spotify paused, nothing playing), the resting line fades out too. */
const QUIET_MS = 15_000;

export type LevelTracker = {
  push: (line: string, now: number) => void;
  /** Moves the drawn levels towards the latest frame. Call once per animation frame. */
  step: (elapsedMs: number, now: number) => void;
  /** 0..1 per band, as bytes for the shader's texture. */
  levels: Uint8Array;
  energy: () => number;
  /** Frames are arriving and something has been heard lately: the glow should be up. */
  live: (now: number) => boolean;
};

const toUnit = (db: number, peak: number) => Math.min(1, Math.max(0, (db - (peak - RANGE_DB)) / RANGE_DB));
const approach = (from: number, to: number, rate: number) => from + (to - from) * rate;

export function createLevelTracker(): LevelTracker {
  const targets = new Float32Array(BANDS);
  const drawn = new Float32Array(BANDS);
  const peaks = new Float32Array(BANDS).fill(-40);
  const levels = new Uint8Array(BANDS);
  let rmsPeak = -30;
  let targetEnergy = 0;
  let energy = 0;
  let lastFrameAt = -Infinity;
  let lastSoundAt = -Infinity;
  let lastPushAt = 0;

  const push = (line: string, now: number) => {
    const values = line.trim().split(" ").map(Number);
    if (values.length < BANDS + 1 || values.some((value) => !Number.isFinite(value))) return;
    const elapsed = lastPushAt ? Math.min(1, (now - lastPushAt) / 1000) : 0;
    lastPushAt = now;
    lastFrameAt = now;
    const [rms, ...bands] = values;
    const silent = rms < SILENCE_DB;
    if (!silent) lastSoundAt = now;
    rmsPeak = Math.max(rms, rmsPeak - PEAK_FALL_DB_PER_S * elapsed);
    targetEnergy = silent ? 0 : toUnit(rms, rmsPeak + 6);
    for (let band = 0; band < BANDS; band += 1) {
      peaks[band] = Math.max(bands[band], peaks[band] - PEAK_FALL_DB_PER_S * elapsed);
      targets[band] = silent ? 0 : toUnit(bands[band], peaks[band]) ** 1.6;
    }
  };

  const step = (elapsedMs: number, now: number) => {
    const frames = Math.min(4, elapsedMs / (1000 / 60));
    const gone = now - lastFrameAt > STALE_MS;
    for (let band = 0; band < BANDS; band += 1) {
      const target = gone ? 0 : targets[band];
      const rate = target > drawn[band] ? ATTACK : RELEASE;
      drawn[band] = approach(drawn[band], target, 1 - (1 - rate) ** frames);
      levels[band] = Math.round(drawn[band] * 255);
    }
    energy = approach(energy, gone ? 0 : targetEnergy, 1 - (1 - RELEASE) ** frames);
  };

  return { push, step, levels, energy: () => energy, live: (now) => now - lastFrameAt < STALE_MS && now - lastSoundAt < QUIET_MS };
}
