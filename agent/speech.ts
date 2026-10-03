// Speaking out loud with macOS `say`, one line at a time, with Spotify ducked (lib/duck.ts).
//
// While Jarvis talks, .data/jarvis-speaking exists (it holds the pid and when speech started) and
// GET /speaking on the agent's HTTP endpoint says {"speaking": true}. The voice daemon checks
// either one and keeps the mic muted, so Jarvis does not hear itself.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { duck, restore } from "../lib/duck";
import { dataDir } from "../lib/songs-store";
import { config } from "./config";

export const SPEAKING_FILE = () => path.join(dataDir(), "jarvis-speaking");
const MAX_CHARS = 600;
/** say speaks roughly 180 words a minute; the duck's safety timer is set from the text's length. */
const MS_PER_CHAR = 75;
/** The mic stays muted this long after speech ends, for the room's echo. */
const TAIL_MS = 400;

/** Lines queued or being said. Counted from the moment speak() is called, so the mic mutes before the first word. */
let pending = 0;
let current: ChildProcess | null = null;
let queue: Promise<void> = Promise.resolve();

export function isSpeaking(): boolean {
  return pending > 0;
}

function setFlag(on: boolean) {
  try {
    if (on) {
      mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
      writeFileSync(SPEAKING_FILE(), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }), { mode: 0o600 });
    } else {
      rmSync(SPEAKING_FILE(), { force: true });
    }
  } catch (error) {
    console.error("[jarvis] speaking flag:", error);
  }
}

/** Text for `say`: no markup, links or emoji codes, clamped. */
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

function sayOnce(text: string): Promise<void> {
  return new Promise((resolve) => {
    const args = config.voice() ? ["-v", config.voice()] : [];
    // The text goes in on stdin, never as an argument, so nothing in it can be read as an option.
    const child = spawn("/usr/bin/say", args, { stdio: ["pipe", "ignore", "ignore"] });
    current = child;
    const done = () => {
      if (current === child) current = null;
      resolve();
    };
    child.on("error", done);
    child.on("close", done);
    child.stdin?.end(text);
  });
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
  if (pending === 1) setFlag(true);
  const run = queue.then(async () => {
    try {
      await duck(said.length * MS_PER_CHAR + 10_000);
      await sayOnce(said);
    } finally {
      await new Promise((resolve) => setTimeout(resolve, TAIL_MS));
      pending = Math.max(0, pending - 1);
      if (pending === 0) {
        setFlag(false);
        await restore();
      }
    }
  });
  queue = run.catch(() => undefined);
  return run.then(() => ({ said })).catch(() => ({ said }));
}

/** Stops speaking now and brings Spotify back (shutdown). */
export async function stopSpeaking() {
  current?.kill();
  pending = 0;
  setFlag(false);
  await restore();
}

/** A flag left by a crash would keep the mic muted forever. */
export function clearStaleFlag() {
  setFlag(false);
}
