// Worm's voice and the music around it. Worm speaks with Kokoro, an open text-to-speech model run on this Mac by
// scripts/tts/speak.py (set up with scripts/tts/setup.sh), or with macOS `say` until that is set up. Spotify is dimmed, not
// paused, from the moment someone says "hey worm" until Worm has finished answering, and brought back to exactly the
// volume it had before. While Worm speaks, the listener's results are ignored (lib/stage/ears.ts), so it never hears
// itself and wakes on its own words.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { currentVolume, duck, isDucked, restoreAfter, setVolume } from "../duck";
import { ACK_LINES } from "./ack";

/** The listener stays deaf this long after speech ends, for the room's echo. */
const ECHO_MS = 700;
/** The music comes back this long after the last line, so a pause between two lines does not bring it up and down. */
const RELEASE_AFTER_MS = 1_500;
/** The music stays dimmed at most this long if nothing brings it back (a question that is never answered). */
const DIM_AT_MOST_MS = 2 * 60_000;

type Voice = {
  queue: Promise<void>;
  pending: number;
  /** Goes up on hush(); lines queued before it are dropped when their turn comes. */
  generation: number;
  speaking: ChildProcess | null;
  quietUntil: number;
};
const shared = globalThis as { __babStageVoice?: Voice };
const voice = (shared.__babStageVoice ??= { queue: Promise.resolve(), pending: 0, generation: 0, speaking: null, quietUntil: 0 });

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

const musicEnabled = () => process.platform === "darwin" && process.env.STAGE_SPEECH !== "off";

/** Dims Spotify (lib/duck.ts, shared with the coin flip and the Slack agent) until releaseMusic(). */
export function dimMusic(): Promise<void> {
  return musicEnabled() ? duck(DIM_AT_MOST_MS) : Promise.resolve();
}

/** Brings Spotify back to its volume from before it was dimmed, after a short wait in case Worm speaks again. */
export function releaseMusic(afterMs = RELEASE_AFTER_MS): void {
  if (isDucked()) restoreAfter(afterMs);
}

/**
 * Sets the music's volume (0 to 100) for someone who asked for it. While the music is dimmed, this is the volume it
 * comes back to; the dim itself stays until Worm is done.
 */
export const setMusicVolume = (level: number) => setVolume(level);

/** The music's volume as someone in the room would describe it: the undimmed level while Worm is talking. */
export const musicVolume = () => currentVolume();

/** Play, pause, skip or go back in Spotify on this Mac. Works without the Spotify login, through AppleScript. */
export async function controlPlayback(action: "play" | "pause" | "next" | "previous"): Promise<string> {
  const commands = { play: "play", pause: "pause", next: "next track", previous: "previous track" } as const;
  await spotify(commands[action]);
  return spotify("get player state as string");
}

/** The club's words as they are said: B@B is "bahb", B@by "bahby". Web addresses are on the screen, not read out. */
const PRONUNCIATIONS: [RegExp, string][] = [
  [/https?:\/\/\S+/g, "the link on screen"],
  [/\bB@bies\b/gi, "Bobbies"],
  [/\bB@by\b/gi, "Bobby"],
  [/\bB@B\b/gi, "Bob"],
  [/[*_`#<>]/g, ""],
];

export function spokenForm(text: string): string {
  return PRONUNCIATIONS.reduce((line, [pattern, said]) => line.replace(pattern, said), text).replace(/\s+/g, " ").trim().slice(0, 1_000);
}

// --- Kokoro (scripts/tts/speak.py) -----------------------------------------------------------------------------

const VENV_PYTHON = path.join(process.cwd(), ".data/tts-venv/bin/python3");
const KOKORO_MODEL = path.join(process.cwd(), ".data/tts/kokoro-v1.0.onnx");
const KOKORO_SCRIPT = path.join(process.cwd(), "scripts/tts/speak.py");
/** If Kokoro stops working, `say` takes over for this long before Kokoro is tried again. */
const KOKORO_RETRY_MS = 5 * 60_000;

type Kokoro = { process: ChildProcess; nextId: number; waiting: Map<number, () => void> };
const kokoroState = globalThis as { __babKokoro?: Kokoro | null; __babKokoroFailedAt?: number };

const kokoroInstalled = () => existsSync(VENV_PYTHON) && existsSync(KOKORO_MODEL) && process.env.STAGE_TTS !== "say";

function onKokoroLine(kokoro: Kokoro, line: string): void {
  let message: { ready?: boolean; done?: number; error?: string };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  if (message.ready) kokoro.process.stdin?.write(`${JSON.stringify({ warm: ACK_LINES.map(spokenForm) })}\n`);
  if (message.error) console.warn(`[stage] voice: ${message.error}`);
  if (typeof message.done !== "number") return;
  kokoro.waiting.get(message.done)?.();
  kokoro.waiting.delete(message.done);
}

/** The running Kokoro helper, started on first use, or null when it is not set up or has just failed. */
function kokoro(): Kokoro | null {
  if (kokoroState.__babKokoro) return kokoroState.__babKokoro;
  if (!kokoroInstalled() || Date.now() - (kokoroState.__babKokoroFailedAt ?? 0) < KOKORO_RETRY_MS) return null;
  const child = spawn(VENV_PYTHON, [KOKORO_SCRIPT], { stdio: ["pipe", "pipe", "ignore"], env: process.env });
  const started: Kokoro = { process: child, nextId: 1, waiting: new Map() };
  readline.createInterface({ input: child.stdout! }).on("line", (line) => onKokoroLine(started, line));
  child.on("exit", () => {
    kokoroState.__babKokoro = null;
    kokoroState.__babKokoroFailedAt = Date.now();
    for (const resolve of started.waiting.values()) resolve();
  });
  kokoroState.__babKokoro = started;
  return started;
}

function kokoroLine(helper: Kokoro, text: string): Promise<void> {
  return new Promise((resolve) => {
    const id = helper.nextId++;
    helper.waiting.set(id, resolve);
    helper.process.stdin?.write(`${JSON.stringify({ id, text })}\n`);
  });
}

// --- macOS say, the fallback -------------------------------------------------------------------------------------

function sayLine(text: string): Promise<void> {
  return new Promise((resolve) => {
    const voiceName = process.env.STAGE_SAY_VOICE?.trim();
    const child = spawn("say", voiceName ? ["-v", voiceName, text] : [text], { stdio: "ignore" });
    voice.speaking = child;
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/** True while Worm is talking, or just stopped. */
export const isSpeaking = () => voice.pending > 0 || Date.now() < voice.quietUntil;

function finishLine(generation: number): void {
  if (generation !== voice.generation) return;
  voice.speaking = null;
  voice.pending = Math.max(0, voice.pending - 1);
  voice.quietUntil = Date.now() + ECHO_MS;
}

/**
 * Says `text` after whatever is already queued. Resolves when it has been said. Never throws. Kokoro is handed each
 * line at once, so it can be synthesising the next sentence while the current one plays; `say` takes them in turn.
 */
export function speak(text: string): Promise<void> {
  const line = spokenForm(text);
  if (!line || !musicEnabled()) return Promise.resolve();
  const generation = voice.generation;
  voice.pending += 1;
  void dimMusic();
  const helper = kokoro();
  if (helper) return kokoroLine(helper, line).then(() => finishLine(generation));
  voice.queue = voice.queue.then(async () => {
    if (generation !== voice.generation) return;
    await sayLine(line);
    finishLine(generation);
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
  const helper = kokoroState.__babKokoro;
  if (helper) {
    helper.process.stdin?.write(`${JSON.stringify({ cancel: true })}\n`);
    for (const resolve of helper.waiting.values()) resolve();
    helper.waiting.clear();
  }
  // The echo pause is only for speech that was actually cut off; a silent hush must not make the listener deaf.
  if (wasTalking) voice.quietUntil = Date.now() + ECHO_MS;
}

/** Starts the voice ahead of the first question, so its model is loaded and the quick lines are ready. */
export function warmVoice(): void {
  if (musicEnabled()) kokoro();
}
