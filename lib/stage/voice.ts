// Worm's voice and the music around it. Worm speaks with macOS `say`, one line at a time. Spotify is dimmed, not
// paused, from the moment someone says "hey worm" until Worm has finished answering, and brought back to exactly the
// volume it had before. While Worm speaks, the listener's results are ignored (lib/stage/ears.ts), so it never hears
// itself and wakes on its own words.

import { execFile, spawn, type ChildProcess } from "node:child_process";

/** Spotify's volume while someone asks and Worm answers, as a share of what it was. */
const DIMMED = 0.3;
/** The listener stays deaf this long after speech ends, for the room's echo. */
const ECHO_MS = 700;
/** The music comes back this long after the last line, so a pause between two lines does not bring it up and down. */
const RELEASE_AFTER_MS = 1_500;

type Voice = {
  queue: Promise<void>;
  pending: number;
  /** Goes up on hush(); lines queued before it are dropped when their turn comes. */
  generation: number;
  speaking: ChildProcess | null;
  quietUntil: number;
  /** Spotify's volume before Worm dimmed it, or null while it is not dimmed. */
  original: number | null;
  /** Every volume change, in order: a dim can never read a volume that a restore is still putting back. */
  volumeOps: Promise<void>;
  releaseTimer?: NodeJS.Timeout;
};
const shared = globalThis as { __babStageVoice?: Voice };
const voice = (shared.__babStageVoice ??= { queue: Promise.resolve(), pending: 0, generation: 0, speaking: null, quietUntil: 0, original: null, volumeOps: Promise.resolve() });

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

function volumeOp(op: () => Promise<void>): Promise<void> {
  voice.volumeOps = voice.volumeOps.then(op, op);
  return voice.volumeOps;
}

const musicEnabled = () => process.platform === "darwin" && process.env.STAGE_SPEECH !== "off";

/** Dims Spotify, once, until releaseMusic(). Called when "hey worm" is heard and before Worm speaks. */
export function dimMusic(): Promise<void> {
  clearTimeout(voice.releaseTimer);
  if (!musicEnabled()) return Promise.resolve();
  return volumeOp(async () => {
    if (voice.original !== null) return;
    const volume = Number(await spotify("get sound volume"));
    if (!Number.isFinite(volume) || volume <= 0) return;
    voice.original = volume;
    await spotify(`set sound volume to ${Math.round(volume * DIMMED)}`);
  });
}

/** Brings Spotify back to its volume from before it was dimmed, after a short wait in case Worm speaks again. */
export function releaseMusic(afterMs = RELEASE_AFTER_MS): void {
  clearTimeout(voice.releaseTimer);
  voice.releaseTimer = setTimeout(() => {
    void volumeOp(async () => {
      const original = voice.original;
      voice.original = null;
      if (original !== null) await spotify(`set sound volume to ${original}`);
    });
  }, afterMs);
}

/**
 * Sets the music's volume (0 to 100) for someone who asked for it. While Worm has the music dimmed, this is the volume
 * it comes back to; the dim itself stays until Worm is done.
 */
export function setMusicVolume(level: number): Promise<void> {
  const target = Math.round(Math.min(100, Math.max(0, level)));
  return volumeOp(async () => {
    if (voice.original !== null) voice.original = target;
    else await spotify(`set sound volume to ${target}`);
  });
}

/** The music's volume as someone in the room would describe it: the undimmed level while Worm is talking. */
export async function musicVolume(): Promise<number | null> {
  await voice.volumeOps;
  if (voice.original !== null) return voice.original;
  const volume = Number(await spotify("get sound volume"));
  return Number.isFinite(volume) ? volume : null;
}

/** Play, pause, skip or go back in Spotify on this Mac. Works without the Spotify login, through AppleScript. */
export async function controlPlayback(action: "play" | "pause" | "next" | "previous"): Promise<string> {
  const commands = { play: "play", pause: "pause", next: "next track", previous: "previous track" } as const;
  await spotify(commands[action]);
  return spotify("get player state as string");
}

function sayLine(text: string): Promise<void> {
  return new Promise((resolve) => {
    const args = process.env.STAGE_VOICE?.trim() ? ["-v", process.env.STAGE_VOICE.trim(), text] : [text];
    const child = spawn("say", args, { stdio: "ignore" });
    voice.speaking = child;
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/** True while Worm is talking, or just stopped. */
export const isSpeaking = () => voice.pending > 0 || Date.now() < voice.quietUntil;

/** Says `text` after whatever is already queued. Resolves when it has been said. Never throws. */
export function speak(text: string): Promise<void> {
  // A web address is never read out letter by letter: it is on the screen.
  const line = text.replace(/https?:\/\/\S+/g, "the link on screen").replace(/[*_`#<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!line || !musicEnabled()) return Promise.resolve();
  const generation = voice.generation;
  voice.pending += 1;
  void dimMusic();
  voice.queue = voice.queue.then(async () => {
    if (generation !== voice.generation) return;
    await sayLine(line);
    if (generation !== voice.generation) return;
    voice.speaking = null;
    voice.pending -= 1;
    voice.quietUntil = Date.now() + ECHO_MS;
  });
  return voice.queue;
}

/** Stops talking now (a new question, or "thanks worm"). The music stays dimmed if a new question is starting. */
export function hush(): void {
  const wasTalking = voice.pending > 0;
  voice.generation += 1;
  voice.speaking?.kill("SIGTERM");
  voice.speaking = null;
  voice.pending = 0;
  // The echo pause is only for speech that was actually cut off; a silent hush must not make the listener deaf.
  if (wasTalking) voice.quietUntil = Date.now() + ECHO_MS;
}
