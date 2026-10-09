// B@B Jarvis: the long-running agent on the Mac mini (`npm run jarvis`, or launchd's com.bab.jarvis).
// Starts the local HTTP endpoint (/health), the Slack Socket Mode listener, the
// Slack nudges for the wall's tiles (agent/feeds.ts), the scheduler (busy threads, songs loop) and
// games (agent/games: a saved Mafia game picks up where it was).
// Kept out of the Next process on purpose.
// Everything missing is logged and switched off; nothing missing stops the agent from starting.

import { loadedEnvFiles } from "./env";
import type { Server } from "node:http";
import { config, missingConfig } from "./config";
import { closeDb, openDb } from "./db";
import { startFeeds, stopFeeds } from "./feeds";
import { startGames, stopGames } from "./games";
import { startHttp } from "./http";
import { startScheduler, stopScheduler } from "./scheduler";
import { startSlack, stopSlack } from "./slack";
import { stopSpeaking } from "./speech";

let server: Server | null = null;
let shuttingDown = false;

async function main() {
  console.log(`[jarvis] Starting. Env from ${loadedEnvFiles.join(", ") || "the process only (no .env.local)"}.`);
  for (const line of missingConfig()) console.warn(`[jarvis] Missing ${line}`);
  if (config.dryRun()) console.warn("[jarvis] JARVIS_DRY_RUN=1: no Spotify, speech, screen or Slack side effects.");

  openDb();

  try {
    server = await startHttp();
    console.log(`[jarvis] HTTP on http://127.0.0.1:${config.port()} (GET /health).`);
  } catch (error) {
    console.error(`[jarvis] Could not listen on 127.0.0.1:${config.port()}:`, error instanceof Error ? error.message : error);
    process.exit(1);
  }

  await startSlack();
  startFeeds();
  startScheduler();
  await startGames();
  console.log(`[jarvis] Ready. Model ${config.fireworksKey() ? config.model() : "(none: rules only)"}, daily cap $${config.dailyCap()}.`);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[jarvis] ${signal}: shutting down.`);
  const force = setTimeout(() => process.exit(1), 8_000);
  force.unref();
  stopScheduler();
  stopFeeds();
  stopGames();
  await Promise.allSettled([
    new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    }),
    stopSlack(),
    stopSpeaking(),
  ]);
  closeDb();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (error) => console.error("[jarvis] Unhandled rejection:", error));

void main();
