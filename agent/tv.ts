// The TV's power over the network: the clubroom TV is a Hisense (VIDAA) on the same network as the
// Mac mini, and it wakes from standby on a Wake-on-LAN packet. Turn on Wake on LAN (or Wake on
// Wi-Fi) in the TV's network settings and set JARVIS_TV_MAC to its MAC address (shown in the same
// settings). JARVIS_TV_IP is optional: with it, "status" says whether the TV answers on the network.
//
// - Commands: "on", "off" and "status" (rules fast path, agent/rules.ts).
// - Watchdog: every JARVIS_TV_WATCH_SECONDS (default 60, 0 off) sends a wake packet. A TV that is
//   already on ignores it, so one that was turned off comes back on within a minute. "off" stops
//   the watchdog until someone says "on" (the TV itself is turned off with its remote: waking is
//   the only thing it takes over the network). The hold is kept in .data/tv.json, so a restart
//   does not undo it.

import { createSocket } from "node:dgram";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import path from "node:path";
import { dataDir } from "../lib/songs-store";
import { config } from "./config";

export type TvAction = "on" | "off" | "status";

export type TvResult = { ok: boolean; message: string };

const WOL_PORT = 9;
// AirPlay's port; the TV answers on it while it is awake.
const PROBE_PORT = 7000;
const PROBE_TIMEOUT_MS = 2_000;

const NO_MAC = "JARVIS_TV_MAC isn't set, so I can't wake the TV.";

/** "AA:BB:CC:DD:EE:FF" (or with - or no separators) as six bytes, or null. */
export function parseMac(mac: string): Buffer | null {
  const hex = mac.replace(/[:\-.\s]/g, "");
  return /^[0-9a-f]{12}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

/** Six 0xFF bytes, then the MAC sixteen times. */
export function magicPacket(mac: Buffer): Buffer {
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => mac)]);
}

/** Broadcasts the wake packet, and sends it to JARVIS_TV_IP too when that is set. */
function wake(mac: Buffer): Promise<boolean> {
  const packet = magicPacket(mac);
  const targets = ["255.255.255.255", config.tvIp()].filter(Boolean);
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    socket.once("error", () => {
      socket.close();
      resolve(false);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      let pending = targets.length;
      let sent = false;
      for (const target of targets) {
        socket.send(packet, WOL_PORT, target, (error) => {
          sent ||= !error;
          if (--pending === 0) {
            socket.close();
            resolve(sent);
          }
        });
      }
    });
  });
}

/** Whether the TV accepts a connection on its AirPlay port. */
function answers(ip: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false));
    socket.once("error", () => done(false));
    socket.connect(PROBE_PORT, ip, () => done(true));
  });
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

/** "on" wakes the TV and keeps it on, "off" stops keeping it on, "status" says what is going on. */
export async function tv(action: TvAction, options: { dryRun?: boolean } = {}): Promise<TvResult> {
  const dryRun = options.dryRun ?? config.dryRun();
  if (dryRun) return { ok: true, message: `TV ${action} (dry run)` };

  if (action === "off") {
    setHeldOff(true);
    return { ok: true, message: "I'll stop turning the TV on until someone says on. Turn it off with the remote." };
  }

  if (action === "status") {
    const keeping = heldOff() ? "I'm leaving it off until someone says on." : "I'm keeping it on.";
    const ip = config.tvIp();
    if (!ip) return { ok: true, message: keeping };
    return { ok: true, message: `${(await answers(ip)) ? "The TV is answering on the network." : "The TV isn't answering on the network."} ${keeping}` };
  }

  setHeldOff(false);
  const mac = parseMac(config.tvMac());
  if (!mac) return { ok: false, message: NO_MAC };
  return (await wake(mac)) ? { ok: true, message: "TV on." } : { ok: false, message: "I couldn't send the wake packet to the TV." };
}

// ---- watchdog ---------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let lastProblem = "";

/** Logs a problem once, not on every tick, until it changes. */
function problem(message: string): void {
  if (message !== lastProblem) console.warn(`[tv] ${message}`);
  lastProblem = message;
}

async function check(mac: Buffer): Promise<void> {
  if (heldOff()) return;
  if (await wake(mac)) lastProblem = "";
  else problem("Could not send the wake packet (is Local Network access allowed for node?).");
}

export function startTvWatch(): void {
  const seconds = config.tvWatchSeconds();
  if (seconds <= 0 || config.dryRun()) return;
  const mac = parseMac(config.tvMac());
  if (!mac) return problem(`${NO_MAC} The TV watchdog is off.`);
  void check(mac);
  timer = setInterval(() => void check(mac), seconds * 1000);
  console.log(`[tv] Waking the TV every ${seconds}s unless someone said off.`);
}

export function stopTvWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
