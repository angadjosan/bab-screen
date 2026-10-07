// Push from the Jarvis agent's Slack listener (Socket Mode) into the Next app, so the Slack-backed
// tiles re-read their channel when something is posted instead of waiting for the next poll.
//
// The agent never writes the tiles' data: it POSTs a nudge to /api/slack/nudge (127.0.0.1 only,
// x-screen-secret) and this process re-reads Slack itself, so every .data file keeps one owner.
// Each nudge, and a heartbeat the agent sends every minute, also says "the listener is up"; while
// it is, the pollers slow down to a long safety interval. Without the agent, or without
// SLACK_APP_TOKEN, nothing arrives here and the pollers run exactly as before.

export const SLACK_FEEDS = ["spots", "chum", "quotes", "songs"] as const;
export type SlackFeed = (typeof SLACK_FEEDS)[number];

/** How long one heartbeat or nudge counts as "the listener is up". The agent sends one a minute. */
export const LISTENER_TTL_MS = 3 * 60_000;

// On globalThis so every route bundle (the nudge route and the tiles' routes) sees the same marks.
// nudges counts per feed rather than timing them, so a cache can tell "read before the last nudge" exactly.
type Live = { listenerUntil: number; nudges: Record<SlackFeed, number> };
const globalStore = globalThis as typeof globalThis & { __babSlackLive?: Live };
const live: Live = (globalStore.__babSlackLive ??= {
  listenerUntil: 0,
  nudges: { spots: 0, chum: 0, quotes: 0, songs: 0 },
});

export function isSlackFeed(value: unknown): value is SlackFeed {
  return typeof value === "string" && (SLACK_FEEDS as readonly string[]).includes(value);
}

export function markListenerAlive(now = Date.now()): void {
  live.listenerUntil = now + LISTENER_TTL_MS;
}

/** True while the agent's listener has been heard from in the last LISTENER_TTL_MS. */
export function slackListenerLive(now = Date.now()): boolean {
  return now < live.listenerUntil;
}

export function markNudged(feed: SlackFeed, now = Date.now()): void {
  live.nudges[feed] += 1;
  markListenerAlive(now);
}

/** How many times the listener has said `feed`'s channel changed. A read taken at a lower count is stale. */
export function nudgeCount(feed: SlackFeed): number {
  return live.nudges[feed];
}
