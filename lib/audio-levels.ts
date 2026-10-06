// What this Mac is playing, as loudness per frequency band 30 times a second, for the waveform along the bottom of
// the screen (app/EdgeGlow.tsx, through /api/audio-levels). Spotify's Web API no longer gives apps any audio
// analysis, so the sound is read off the Mac's own output by scripts/audio-levels/AudioLevels.swift, a Core Audio
// process tap. That helper is compiled into .data on first use, runs while at least one page is listening, and is
// restarted if it stops. It needs macOS 14.2 or later and the "System Audio Recording" permission.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const SOURCE = path.join(process.cwd(), "scripts/audio-levels/AudioLevels.swift");
const INFO_PLIST = path.join(process.cwd(), "scripts/audio-levels/Info.plist");
const BINARY = path.join(process.cwd(), ".data/audio-levels");
/** The helper keeps running this long after the last page stops listening, so a reload does not restart it. */
const IDLE_STOP_MS = 30_000;
const RESTART_MIN_MS = 5_000;
const RESTART_MAX_MS = 5 * 60_000;
const COMPILE_TIMEOUT_MS = 5 * 60_000;

export type AudioLevelsStatus = "off" | "starting" | "running" | "unavailable";
/** One frame, as the helper prints it: overall loudness, then each band's, all in dB. */
type Listener = (line: string) => void;

type State = {
  listeners: Set<Listener>;
  status: AudioLevelsStatus;
  helper: ChildProcess | null;
  idleTimer?: NodeJS.Timeout;
  restartTimer?: NodeJS.Timeout;
  restartMs: number;
  lastError: string | null;
};

const shared = globalThis as { audioLevels?: State };
const state = (shared.audioLevels ??= { listeners: new Set(), status: "off", helper: null, restartMs: RESTART_MIN_MS, lastError: null });

export const audioLevelsEnabled = () => process.platform === "darwin" && process.env.AUDIO_LEVELS !== "off";

async function modified(file: string) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** Builds the helper when it is missing or older than its source. Resolves to an error message, or null. */
async function compile(): Promise<string | null> {
  const [built, source] = await Promise.all([modified(BINARY), modified(SOURCE)]);
  if (source === null) return "scripts/audio-levels/AudioLevels.swift is missing";
  if (built !== null && built >= source) return null;
  // The Info.plist is linked into the binary: macOS asks for the audio recording permission in its name.
  const args = ["-O", SOURCE, "-o", BINARY, "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", INFO_PLIST];
  return new Promise((resolve) => {
    execFile("swiftc", args, { timeout: COMPILE_TIMEOUT_MS }, (error, _out, stderr) => resolve(error ? `swiftc failed: ${String(stderr).trim() || error.message}` : null));
  });
}

function scheduleRestart() {
  if (!state.listeners.size) return;
  clearTimeout(state.restartTimer);
  state.restartTimer = setTimeout(() => void start(), state.restartMs);
  state.restartMs = Math.min(RESTART_MAX_MS, state.restartMs * 2);
}

function attach(helper: ChildProcess) {
  readline.createInterface({ input: helper.stdout! }).on("line", (line) => {
    if (state.status !== "running") {
      state.status = "running";
      state.restartMs = RESTART_MIN_MS;
    }
    for (const listener of state.listeners) listener(line);
  });
  helper.stderr?.on("data", (chunk) => {
    state.lastError = String(chunk).trim();
  });
  helper.on("exit", () => {
    if (state.helper !== helper) return;
    state.helper = null;
    state.status = state.listeners.size ? "unavailable" : "off";
    if (state.lastError) console.warn(`[audio-levels] ${state.lastError}`);
    scheduleRestart();
  });
}

async function start() {
  if (state.helper || state.status === "starting" || !audioLevelsEnabled()) return;
  state.status = "starting";
  const problem = await compile();
  if (problem) {
    state.status = "unavailable";
    state.lastError = problem;
    console.warn(`[audio-levels] ${problem}`);
    return scheduleRestart();
  }
  if (!state.listeners.size) {
    state.status = "off";
    return;
  }
  // stdin stays open as a lifeline: the helper exits when it closes, so it never outlives this server.
  const helper = spawn(BINARY, [], { stdio: ["pipe", "pipe", "pipe"] });
  state.helper = helper;
  attach(helper);
}

function stop() {
  clearTimeout(state.restartTimer);
  state.helper?.kill("SIGTERM");
  state.helper = null;
  state.status = "off";
  state.restartMs = RESTART_MIN_MS;
}

/** Calls `listener` with every frame until the returned function is called. Starts the helper if it is not running. */
export function listenToAudioLevels(listener: Listener): () => void {
  state.listeners.add(listener);
  clearTimeout(state.idleTimer);
  void start();
  return () => {
    state.listeners.delete(listener);
    if (state.listeners.size) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(stop, IDLE_STOP_MS);
  };
}

export const audioLevelsStatus = () => ({ status: state.status, error: state.lastError });
