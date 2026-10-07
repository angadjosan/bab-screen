// Speaking out loud, in Worm's voice: each line goes to the Next app (POST /api/stage/say), which says it with the
// stage's text-to-speech (lib/stage/voice.ts) and dims Spotify meanwhile. One voice in the room, and Worm's ears
// (lib/stage/ears.ts) know not to listen to it.

import { config } from "./config";

const MAX_CHARS = 600;
/** Kokoro and `say` both run near 180 words a minute; a line that takes far longer than that has gone wrong. */
const MS_PER_CHAR = 120;
const MIN_TIMEOUT_MS = 10_000;

/** Lines queued or being said. Counted from the moment speak() is called. */
let pending = 0;
let queue: Promise<void> = Promise.resolve();
let current: AbortController | null = null;

export function isSpeaking(): boolean {
  return pending > 0;
}

/** Text to say: no markup, links or emoji codes, clamped. */
export function speakable(text: string): string {
  const cleaned = text
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<[^>]+>/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > MAX_CHARS ? `${cleaned.slice(0, MAX_CHARS).replace(/\s+\S*$/, "")}.` : cleaned;
}

async function sayInTheRoom(text: string): Promise<void> {
  const secret = config.screenSecret();
  if (!secret) {
    console.error("[jarvis] speech: SCREEN_SECRET is not set, so the Next app would refuse it");
    return;
  }
  current = new AbortController();
  const timeout = AbortSignal.timeout(Math.max(MIN_TIMEOUT_MS, text.length * MS_PER_CHAR));
  try {
    const response = await fetch(`${config.nextUrl()}/api/stage/say`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-screen-secret": secret },
      body: JSON.stringify({ text }),
      signal: AbortSignal.any([current.signal, timeout]),
    });
    if (!response.ok) console.error(`[jarvis] speech: the Next app answered ${response.status}`);
  } catch (error) {
    console.error("[jarvis] speech:", error instanceof Error ? error.message : error);
  } finally {
    current = null;
  }
}

/** Speaks `text`, after anything already queued. Resolves when it has been said. Never throws. */
export function speak(text: string, options: { dryRun?: boolean } = {}): Promise<{ said: string; dryRun?: boolean }> {
  const said = speakable(text);
  if (!said) return Promise.resolve({ said: "" });
  if (options.dryRun ?? config.dryRun()) {
    console.log(`[jarvis] dry run: say "${said}"`);
    return Promise.resolve({ said, dryRun: true });
  }
  pending += 1;
  const run = queue.then(() => sayInTheRoom(said)).finally(() => {
    pending = Math.max(0, pending - 1);
  });
  queue = run.catch(() => undefined);
  return run.then(() => ({ said })).catch(() => ({ said }));
}

/** Stops waiting on the line being said (shutdown). */
export function stopSpeaking() {
  current?.abort();
  pending = 0;
}
