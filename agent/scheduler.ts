// Background jobs:
// - Busy threads: every JARVIS_SCHEDULER_SECONDS (default 120), look at the last 6 hours of
//   SLACK_CHANNEL_ID. A thread with JARVIS_PIN_MIN_REPLIES (default 5) or more replies in the last
//   15 minutes is pinned to the TV; the pinned thread is refreshed while it is active and unpinned
//   once it has been quiet for 20 minutes. A thread someone asked to pin is left alone for 30 minutes.
//   A reply seen by the Socket Mode listener brings the next check forward.
// - Songs loop: kicks GET /api/songs/sync on the Next app every 5 minutes (it is idempotent), so
//   the 20-second song-request poll is running after a boot or a Next restart.
// - Market moves: stub, see checkMarkets().

import { config } from "./config";
import { logEvent } from "./db";
import { history, threadReplies, type SlackMsg } from "./slack-api";
import { onChannelMessage } from "./slack";
import { currentPin, pinThread, unpinThread } from "./threads";

const WINDOW_MS = 6 * 3_600_000;
const VELOCITY_MS = 15 * 60_000;
const QUIET_MS = 20 * 60_000;
const REQUEST_HOLD_MS = 30 * 60_000;
const MAX_THREADS_CHECKED = 4;
const SONGS_KICK_MS = 5 * 60_000;
const SONGS_RETRY_MS = 10_000;

const SCHEDULER = { id: null, name: "scheduler", source: "scheduler" } as const;

const timers = new Set<NodeJS.Timeout>();
let stopped = false;
let running = false;
let nudge: NodeJS.Timeout | null = null;

const tsMs = (ts: string | undefined) => (ts ? Math.round(Number(ts) * 1000) : 0);

/** Replies in the last VELOCITY_MS for the busiest recent threads. Pure on its input, for tests. */
export function pickBusyThread(threads: Array<{ ts: string; replyTimes: number[] }>, now: number, minReplies: number): { ts: string; recent: number } | null {
  let best: { ts: string; recent: number } | null = null;
  for (const thread of threads) {
    const recent = thread.replyTimes.filter((at) => now - at <= VELOCITY_MS).length;
    if (recent >= minReplies && (!best || recent > best.recent)) best = { ts: thread.ts, recent };
  }
  return best;
}

export async function checkBusyThreads(now = Date.now()): Promise<string> {
  const channel = config.slackChannel();
  if (!channel || !config.slackBotToken()) return "skipped: no SLACK_CHANNEL_ID or SLACK_BOT_TOKEN";
  if (running) return "skipped: already running";
  running = true;
  try {
    const pin = currentPin();
    if (pin?.by === "request" && now - pin.at < REQUEST_HOLD_MS) return "held: pinned on request";

    const messages = await history(channel, { oldest: now - WINDOW_MS, limit: 100 });
    const candidates = messages
      .filter((message: SlackMsg) => (message.reply_count ?? 0) > 0 && now - tsMs(message.latest_reply) <= VELOCITY_MS)
      .sort((a, b) => (b.reply_count ?? 0) - (a.reply_count ?? 0))
      .slice(0, MAX_THREADS_CHECKED);
    const threads = await Promise.all(
      candidates.map(async (message) => ({
        ts: message.ts as string,
        replyTimes: (await threadReplies(channel, message.ts as string, 200)).filter((reply) => reply.ts !== message.ts).map((reply) => tsMs(reply.ts)),
      })),
    );
    const busy = pickBusyThread(threads, now, config.pinMinReplies());

    if (busy) {
      const result = await pinThread(channel, busy.ts, "scheduler");
      const what = `${pin?.ts === busy.ts ? "refreshed" : "pinned"} ${busy.ts} (${busy.recent} replies in 15 min)`;
      logEvent(SCHEDULER, "scheduler", "pin_thread", { channel, ts: busy.ts }, result.ok, result.error ?? what);
      return result.ok ? what : `pin failed: ${result.error}`;
    }
    if (pin) {
      const replies = await threadReplies(pin.channel, pin.ts, 200);
      const latest = Math.max(...replies.map((reply) => tsMs(reply.ts)));
      if (now - latest > QUIET_MS) {
        const result = await unpinThread();
        logEvent(SCHEDULER, "scheduler", "unpin_thread", { channel: pin.channel, ts: pin.ts }, result.ok, result.error ?? "quiet");
        return result.ok ? `unpinned ${pin.ts} (quiet)` : `unpin failed: ${result.error}`;
      }
    }
    return "nothing busy";
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    running = false;
  }
}

/**
 * Market moves ("pull up a chart when something moves"): not done here. Prices are read in the
 * browser (lib/markets.ts), and featuring a token on the TV is the Next app's rotation; once the
 * screen state has a way to feature a market this can poll Hyperliquid and push it.
 */
export async function checkMarkets(): Promise<string> {
  return "skipped: not implemented";
}

/** Starts the Next app's song-request poll; retries until Next answers. */
export async function kickSongs(): Promise<boolean> {
  const url = `${config.nextUrl()}/api/songs/sync`;
  try {
    let response = await fetch(url, { method: "POST", signal: AbortSignal.timeout(30_000) });
    // The route only has GET today.
    if (response.status === 405) response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

function every(ms: number, job: () => Promise<unknown>) {
  const timer = setInterval(() => void job(), ms);
  timer.unref();
  timers.add(timer);
}

function later(ms: number, job: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer);
    job();
  }, ms);
  timer.unref();
  timers.add(timer);
}

export function startScheduler() {
  stopped = false;

  const songs = async (attempt = 0) => {
    if (stopped) return;
    if (await kickSongs()) {
      if (attempt > 0) console.log("[jarvis] Song-request loop started on the Next app.");
      return;
    }
    if (attempt === 0) console.warn(`[jarvis] Next app not answering at ${config.nextUrl()}; retrying the songs loop every ${SONGS_RETRY_MS / 1000}s.`);
    later(SONGS_RETRY_MS, () => void songs(attempt + 1));
  };
  void songs();
  every(SONGS_KICK_MS, () => songs(1));

  const seconds = config.schedulerSeconds();
  if (seconds <= 0) {
    console.log("[jarvis] Busy-thread scheduler off (JARVIS_SCHEDULER_SECONDS=0).");
    return;
  }
  const busy = async () => {
    const outcome = await checkBusyThreads();
    if (!outcome.startsWith("nothing") && !outcome.startsWith("skipped")) console.log(`[jarvis] busy threads: ${outcome}`);
  };
  later(5_000, () => void busy());
  every(seconds * 1000, busy);

  // A reply in the watched channel brings the next check forward (at most one every 30 seconds).
  const channel = config.slackChannel();
  if (channel) {
    onChannelMessage(
      "busy-threads",
      (message) => {
        if (!message.threadTs || message.threadTs === message.ts || nudge) return;
        nudge = setTimeout(() => {
          nudge = null;
          void busy();
        }, 30_000);
        nudge.unref();
      },
      channel,
    );
  }
}

export function stopScheduler() {
  stopped = true;
  for (const timer of timers) {
    clearTimeout(timer);
    clearInterval(timer);
  }
  timers.clear();
  if (nudge) clearTimeout(nudge);
  nudge = null;
}
