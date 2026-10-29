// The TV's power over HDMI-CEC. A Mac's own HDMI port does not speak CEC, so this needs a USB-CEC
// adapter (Pulse-Eight) between the Mac mini and the TV, and libcec's cec-client
// (`brew install libcec`). Each call opens the adapter, sends one command and closes it.
//
// - Commands: "on", "off" and "status" (rules fast path, agent/rules.ts).
// - Watchdog: every JARVIS_TV_WATCH_SECONDS (default 60, 0 off) asks the TV for its power state
//   and turns it on if it is in standby. "off" holds it off, and the watchdog leaves it alone,
//   until someone says "on". The hold is kept in .data/tv.json, so a restart does not undo it.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../lib/songs-store";
import { config } from "./config";

export type TvAction = "on" | "off" | "status";

export type TvResult = { ok: boolean; message: string };

// launchd's PATH has no Homebrew in it, so look in its usual places.
const CEC_CLIENT_PATHS = ["/opt/homebrew/bin/cec-client", "/usr/local/bin/cec-client"];

// Opening the adapter takes a few seconds; a TV waking up can take a few more to answer.
const CEC_TIMEOUT_MS = 20_000;

function cecClientPath(): string | null {
  const configured = config.cecClient();
  if (configured) return existsSync(configured) ? configured : null;
  return CEC_CLIENT_PATHS.find((file) => existsSync(file)) ?? null;
}

type CecOutput = { ok: boolean; out: string; noAdapter: boolean };

// One cec-client at a time: two can't hold the adapter together.
let queue: Promise<unknown> = Promise.resolve();

/** Sends one cec-client command (`on 0`, `standby 0`, `pow 0`, `as`) in single-command mode. */
function cec(binary: string, command: string): Promise<CecOutput> {
  const run = () =>
    new Promise<CecOutput>((resolve) => {
      const child = execFile(binary, ["-s", "-d", "1"], { timeout: CEC_TIMEOUT_MS }, (error, stdout, stderr) => {
        const out = `${String(stdout)}\n${String(stderr)}`;
        resolve({ ok: !error, out, noAdapter: /autodetect FAILED|unable to open|could not open|no adapter/i.test(out) });
      });
      child.stdin?.end(`${command}\n`);
    });
  const next = queue.then(run, run);
  queue = next;
  return next;
}

const NOT_INSTALLED = "cec-client isn't installed on the Mac (brew install libcec), so I can't reach the TV.";
const NO_ADAPTER = "I can't find the USB-CEC adapter. Check that it's plugged into the Mac mini and the TV.";

type Power = "on" | "standby" | "transition" | "unknown";

/** The TV's power state as cec-client reports it ("in transition from standby to on" is "transition"). */
export function parsePower(out: string): Power {
  const status = out.match(/power status:\s*(.+?)\s*$/im)?.[1].toLowerCase() ?? "";
  if (status === "on") return "on";
  if (status === "standby") return "standby";
  if (status.startsWith("in transition")) return "transition";
  return "unknown";
}

async function readPower(binary: string): Promise<{ power: Power; noAdapter: boolean }> {
  const result = await cec(binary, "pow 0");
  return { power: result.noAdapter ? "unknown" : parsePower(result.out), noAdapter: result.noAdapter };
}

async function turnOn(binary: string): Promise<TvResult> {
  const result = await cec(binary, "on 0");
  if (result.noAdapter) return { ok: false, message: NO_ADAPTER };
  if (!result.ok) return { ok: false, message: "The TV didn't take that over CEC." };
  // Switch the TV to the Mac's input too, in case it wakes up on another one.
  await cec(binary, "as");
  return { ok: true, message: "TV on." };
}

// ---- the "off" hold ---------------------------------------------------------

const holdFile = () => path.join(dataDir(), "tv.json");

function heldOff(): boolean {
  try {
    return JSON.parse(readFileSync(holdFile(), "utf8")).heldOff === true;
  } catch {
    return false;
  }
}

function setHeldOff(value: boolean): void {
  try {
    mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
    writeFileSync(holdFile(), `${JSON.stringify({ heldOff: value, at: new Date().toISOString() })}\n`);
  } catch (error) {
    console.warn("[tv] Could not save the off hold:", error instanceof Error ? error.message : error);
  }
}

// ---- commands ---------------------------------------------------------------

/** "on" turns the TV on onto the Mac's input, "off" puts it in standby and holds it there, "status" reads it. */
export async function tv(action: TvAction, options: { dryRun?: boolean } = {}): Promise<TvResult> {
  const dryRun = options.dryRun ?? config.dryRun();
  if (dryRun) return { ok: true, message: `TV ${action} (dry run)` };
  const binary = cecClientPath();
  if (!binary) return { ok: false, message: NOT_INSTALLED };

  if (action === "status") {
    const { power, noAdapter } = await readPower(binary);
    if (noAdapter) return { ok: false, message: NO_ADAPTER };
    if (power === "unknown") return { ok: false, message: "The TV didn't answer over CEC." };
    const state = power === "on" ? "on" : power === "standby" ? "off (standby)" : "warming up";
    const hold = heldOff() ? " It's held off until someone says on." : "";
    return { ok: true, message: `The TV is ${state}.${hold}` };
  }

  if (action === "on") {
    setHeldOff(false);
    return turnOn(binary);
  }

  setHeldOff(true);
  const result = await cec(binary, "standby 0");
  if (result.noAdapter) return { ok: false, message: NO_ADAPTER };
  if (!result.ok) return { ok: false, message: "The TV didn't take that over CEC." };
  return { ok: true, message: "TV off. It stays off until someone says on." };
}

// ---- watchdog ---------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let checking = false;
let lastProblem = "";

/** Logs a problem once, not on every tick, until it changes. */
function problem(message: string): void {
  if (message !== lastProblem) console.warn(`[tv] ${message}`);
  lastProblem = message;
}

async function check(): Promise<void> {
  if (checking || heldOff()) return;
  checking = true;
  try {
    const binary = cecClientPath();
    if (!binary) return problem(NOT_INSTALLED);
    const { power, noAdapter } = await readPower(binary);
    if (noAdapter) return problem(NO_ADAPTER);
    lastProblem = "";
    if (power !== "standby") return;
    const result = await turnOn(binary);
    console.log(`[tv] The TV was off. ${result.ok ? "Turned it on." : result.message}`);
  } finally {
    checking = false;
  }
}

export function startTvWatch(): void {
  const seconds = config.tvWatchSeconds();
  if (seconds <= 0 || config.dryRun()) return;
  void check();
  timer = setInterval(() => void check(), seconds * 1000);
  console.log(`[tv] Watching the TV every ${seconds}s; it is turned on when found off.`);
}

export function stopTvWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
