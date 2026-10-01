// Shapes served by GET /api/feed. The dashboard's feed column is written against these.

export type FeedKind = "news" | "tweet";

export type FeedItem = {
  /** Stable across refreshes: a hash of the source and the item's guid or URL. */
  id: string;
  kind: FeedKind;
  /** Publication or network name, e.g. "CoinDesk", "Bluesky", "X". */
  source: string;
  /** Person or account display name, if the source gives one. */
  author: string | null;
  /** e.g. "@VitalikButerin" for posts, otherwise null. */
  handle: string | null;
  /** Headline, or the post text. Plain text: no markup, entities decoded. */
  title: string;
  /** One or two plain-text sentences for news when the feed has them; null for posts. */
  summary: string | null;
  url: string;
  /** ISO 8601. */
  publishedAt: string;
  /** https thumbnail, or null. */
  imageUrl: string | null;
};

export type FeedSourceStatus = {
  name: string;
  kind: FeedKind;
  ok: boolean;
  /** Usable items from this source in the last refresh (after the age cutoff and filters). */
  items: number;
  error: string | null;
};

/** Which model runner made a selection. */
export type FeedAgentName = "codex" | "claude-cli" | "claude-api";

export type FeedResponse = {
  status: "ok" | "degraded" | "empty" | "error";
  /** The curated selection in display order. */
  items: FeedItem[];
  /** When the selection was last made. */
  updatedAt: string | null;
  sources: FeedSourceStatus[];
  /** "agent" when a model (Codex or Claude) picked the items, "fallback" when the deterministic ordering was used. */
  curation: "agent" | "fallback";
  /** Which agent picked the current selection; null when the fallback ordering is showing. */
  agent: FeedAgentName | null;
  /** The model that agent ran, e.g. "gpt-6-luna" or "claude-haiku-4-5"; null with the fallback. */
  agentModel: string | null;
  message?: string;
};
