// The four Slack pollers, folded into the Socket Mode listener: a message in the spots, chumming,
// quotes or songs channel nudges the Next app (POST /api/slack/nudge, 127.0.0.1 only,
// x-screen-secret) to re-read that channel now, and a heartbeat every minute tells it the listener is
// up, so its own polls slow down to a safety interval (lib/slack-live.ts).
//
// The agent only nudges. The Next app does the reading and stays the only writer of .data/songs.json
// and .data/quotes.json, and song requests go through its one lock and cursor, so a track is queued
// once whichever of the poll and the nudge gets there first. Without the listener (no SLACK_APP_TOKEN)
// or without this process, no nudge or heartbeat arrives and the Next app polls as before.

import type { SlackFeed } from "../lib/slack-live";
import { config } from "./config";
import { onChannelMessage, slackStatus, type ChannelMessage } from "./slack";

/** A burst of messages (or a post and its unfurl edit) becomes one nudge. */
const NUDGE_DELAY_MS = 1_500;
/** At most one nudge per feed this often. */
const NUDGE_MIN_GAP_MS = 5_000;
const HEARTBEAT_MS = 60_000;
const TIMEOUT_MS = 5_000;

export const FEED_CHANNELS: Record<SlackFeed, () => string> = {
  spots: config.slackChannel,
  chum: config.chumChannel,
  quotes: config.quotesChannel,
  songs: config.songsChannel,
};

const EDITS = new Set(["message_changed", "message_deleted"]);

type Inner = { ts?: unknown; thread_ts?: unknown; files?: unknown; user?: unknown; bot_id?: unknown };

/** The message an edit or delete is about (Slack nests it), or the message itself. */
function subject(message: ChannelMessage): { ts: string; threadTs: string | null; user: string | null; botId: string | null; raw: Record<string, unknown> } {
  if (!message.subtype || !EDITS.has(message.subtype)) return message;
  const inner = (message.raw.message ?? message.raw.previous_message ?? {}) as Inner;
  return {
    ts: typeof inner.ts === "string" ? inner.ts : message.ts,
    threadTs: typeof inner.thread_ts === "string" ? inner.thread_ts : null,
    user: typeof inner.user === "string" ? inner.user : null,
    botId: typeof inner.bot_id === "string" ? inner.bot_id : null,
    raw: inner as Record<string, unknown>,
  };
}

/** Top level of the channel, which is all conversations.history (and so every tile) reads. */
function topLevel(message: ChannelMessage): boolean {
  if (message.subtype === "thread_broadcast") return true;
  const { ts, threadTs } = subject(message);
  return !threadTs || threadTs === ts;
}

function hasImage(raw: Record<string, unknown>): boolean {
  const list = (key: string) => (Array.isArray(raw[key]) ? (raw[key] as Array<Record<string, unknown>>) : []);
  return list("files").length > 0 || list("attachments").some((item) => item.image_url) || list("blocks").some((block) => block.type === "image");
}

/**
 * Whether `message` (already known to be in `feed`'s channel) can change what that tile shows.
 * Pure, for tests. Edits and deletes count for the photo and quote tiles, which re-read the
 * newest messages; song requests act on new messages only, as the poll does.
 */
export function wantsNudge(feed: SlackFeed, message: ChannelMessage, spotbotId = config.spotbotUserId()): boolean {
  if (!topLevel(message)) return false;
  const { user, botId, raw } = subject(message);
  return NUDGE_RULES[feed]({
    message,
    raw,
    edit: Boolean(message.subtype && EDITS.has(message.subtype)),
    byPerson: Boolean(user) && !botId,
    bySpotbot: !spotbotId || user === spotbotId || botId === spotbotId,
  });
}

type NudgeFacts = { message: ChannelMessage; raw: Record<string, unknown>; edit: boolean; byPerson: boolean; bySpotbot: boolean };

const plainPost = (message: ChannelMessage) => !message.subtype || message.subtype === "file_share" || message.subtype === "thread_broadcast";

const NUDGE_RULES: Record<SlackFeed, (facts: NudgeFacts) => boolean> = {
  spots: ({ bySpotbot, edit, raw }) => bySpotbot && (edit || hasImage(raw)),
  chum: ({ byPerson, edit, raw }) => byPerson && (edit || hasImage(raw)),
  quotes: ({ byPerson, edit, message }) => byPerson && (edit || plainPost(message)),
  songs: ({ byPerson, edit, message }) => byPerson && !edit && plainPost(message),
};

export type NudgeResult = { ok: boolean; status: number | null; error?: string; dryRun?: boolean };

/** POST /api/slack/nudge on the Next app. Never throws. */
export async function postNudge(body: { feed: SlackFeed | "listener"; ts?: string }, options: { dryRun?: boolean } = {}): Promise<NudgeResult> {
  if (options.dryRun ?? config.dryRun()) {
    if (body.feed !== "listener") console.log("[jarvis] dry run: nudge", JSON.stringify(body));
    return { ok: true, status: null, dryRun: true };
  }
  const secret = config.screenSecret();
  if (!secret) return { ok: false, status: null, error: "SCREEN_SECRET is not set, so the Next app would refuse this" };
  try {
    const response = await fetch(`${config.nextUrl()}/api/slack/nudge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-screen-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (!response.ok) return { ok: false, status: response.status, error: answer?.error ? String(answer.error) : `http_${response.status}` };
    return { ok: true, status: response.status };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, status: null, error: name === "TimeoutError" ? "next_timeout" : "next_unreachable (is the Next app running on :3000?)" };
  }
}

type Pending = { timer: NodeJS.Timeout | null; lastSentAt: number; ts: string | null };
const pending = new Map<SlackFeed, Pending>();
let heartbeat: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let registered = false;

function report(result: NudgeResult) {
  if (result.ok) {
    if (lastError) console.log("[jarvis] Next app takes Slack nudges again.");
    lastError = null;
  } else if (result.error !== lastError) {
    // Once per new problem: the Next app's own polls keep the tiles going meanwhile.
    lastError = result.error ?? "unknown";
    console.warn(`[jarvis] Slack nudge refused: ${lastError}. The Next app falls back to polling.`);
  }
}

// Slack ts strings have a fixed width ("1712345678.123456"), so they sort as text.
const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a >= b ? a : b);

/** Queues a nudge for `feed`, sent NUDGE_DELAY_MS from now and at least NUDGE_MIN_GAP_MS after the last. */
export function queueNudge(feed: SlackFeed, ts: string | null, send: typeof postNudge = postNudge) {
  const entry = pending.get(feed) ?? { timer: null, lastSentAt: 0, ts: null };
  pending.set(feed, entry);
  entry.ts = later(entry.ts, ts);
  if (entry.timer) return;
  const wait = Math.max(NUDGE_DELAY_MS, entry.lastSentAt + NUDGE_MIN_GAP_MS - Date.now());
  entry.timer = setTimeout(() => {
    entry.timer = null;
    entry.lastSentAt = Date.now();
    const body = { feed, ...(entry.ts ? { ts: entry.ts } : {}) };
    entry.ts = null;
    void send(body).then(report);
  }, wait);
  entry.timer.unref();
}

/** Routes each tile's channel to a nudge, and starts the heartbeat. Channels that are not set are skipped. */
export function startFeeds() {
  if (!registered) {
    registered = true;
    for (const [feed, channel] of Object.entries(FEED_CHANNELS) as Array<[SlackFeed, () => string]>) {
      const id = channel();
      if (!id) continue;
      onChannelMessage(`feed:${feed}`, (message) => {
        if (wantsNudge(feed, message)) queueNudge(feed, subject(message).ts);
      }, id);
    }
  }
  const beat = () => {
    if (slackStatus().listening && !config.dryRun()) void postNudge({ feed: "listener" }).then(report);
  };
  beat();
  heartbeat = setInterval(beat, HEARTBEAT_MS);
  heartbeat.unref();
}

export function stopFeeds() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
}
