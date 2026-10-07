// Worm's voice: macOS `say`, one line at a time, with Spotify turned down while it talks. While it speaks, the
// listener's results are ignored (lib/stage/ears.ts), so Worm never hears itself and wakes on its own words.

import { execFile, spawn, type ChildProcess } from "node:child_process";

/** Spotify's volume while Worm talks, as a share of what it was. */
const DUCKED = 0.25;
/** The listener stays deaf this long after speech ends, for the room's echo. */
const ECHO_MS = 700;

/** `generation` goes up on hush(), and lines queued before it are dropped when their turn comes. */
type Voice = { queue: Promise<void>; pending: number; generation: number; speaking: ChildProcess | null; volume: number | null; quietUntil: number };
const shared = globalThis as { __babStageVoice?: Voice };
const voice = (shared.__babStageVoice ??= { queue: Promise.resolve(), pending: 0, generation: 0, speaking: null, volume: null, quietUntil: 0 });

const spotify = (command: string) =>
  new Promise<string>((resolve) => {
    execFile("osascript", ["-e", `if application "Spotify" is running then tell application "Spotify" to ${command}`], { timeout: 3_000 }, (error, out) => resolve(error ? "" : String(out).trim()));
  });

async function duck(): Promise<void> {
  if (voice.volume !== null) return;
  const volume = Number(await spotify("get sound volume"));
  if (!Number.isFinite(volume) || volume <= 0) return;
  voice.volume = volume;
  await spotify(`set sound volume to ${Math.round(volume * DUCKED)}`);
}

async function restore(): Promise<void> {
  const volume = voice.volume;
  voice.volume = null;
  if (volume !== null) await spotify(`set sound volume to ${volume}`);
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
  const line = text.replace(/[*_`#<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!line || process.platform !== "darwin" || process.env.STAGE_SPEECH === "off") return Promise.resolve();
  const generation = voice.generation;
  voice.pending += 1;
  voice.queue = voice.queue.then(async () => {
    if (generation !== voice.generation) return;
    await duck();
    await sayLine(line);
    if (generation !== voice.generation) return;
    voice.speaking = null;
    voice.pending -= 1;
    voice.quietUntil = Date.now() + ECHO_MS;
    if (voice.pending === 0) await restore();
  });
  return voice.queue;
}

/** Stops talking now and gives Spotify its volume back (a new question, or "thanks worm"). */
export function hush(): void {
  const wasTalking = voice.pending > 0;
  voice.generation += 1;
  voice.speaking?.kill("SIGTERM");
  voice.speaking = null;
  voice.pending = 0;
  // The echo pause is only for speech that was actually cut off; a silent hush must not make the listener deaf.
  if (wasTalking) voice.quietUntil = Date.now() + ECHO_MS;
  void restore();
}
