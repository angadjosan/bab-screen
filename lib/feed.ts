// News-and-posts feed for the wall: gathers candidates from the sources in feed-sources.ts,
// has a model pick about twenty (feed-agent.ts: Codex by default, or Claude), and serves the
// selection from memory.
//
// GET /api/feed never waits for any of that. It answers from the last selection (kept in memory
// and in feed.json in the store, lib/store.ts, so a restart or another instance shows it at once)
// and starts a refresh in the background when the selection is older than REFRESH_MINUTES. The
// refresh is the "feed" job (lib/jobs.ts): one instance at a time, also run by the cron route, and
// only while a screen is asking: after IDLE_PAUSE_MINUTES without a request it stops fetching and
// stops calling the model.
//
// The same refresh also feeds lib/newsworthy.ts (tokens in the news, served by /api/newsworthy).

import { AgentError, agentPlan, fallbackOrder, pickWithAgent, type AgentAttempt } from "./feed-agent";
import { gatherSources, type SourceCache, type SourceResult } from "./feed-fetch";
import { cluster } from "./feed-parse";
import {
  HISTORY_SELECTIONS,
  IDLE_PAUSE_MINUTES,
  MAX_CANDIDATES,
  MAX_ITEMS,
  PER_ACCOUNT_CANDIDATES,
  PER_SOURCE_CANDIDATES,
  REFRESH_MINUTES,
  TARGET_ITEMS,
} from "./feed-sources";
import { inBackground, noteDemand, runJob, type JobSpec } from "./jobs";
import { refreshNewsworthy } from "./newsworthy";
import { readJson, reloadAfterMs, writeJson } from "./store";
import type { FeedAgentName, FeedItem, FeedResponse, FeedSourceStatus } from "./feed-types";

export type { FeedAgentName, FeedItem, FeedResponse, FeedSourceStatus } from "./feed-types";

const STATE_FILE = "feed.json";
const STATE_VERSION = 1;
/**
 * Longer than a refresh can take: fetching, one model call for the feed and one for the
 * newsworthy tokens, each up to FEED_AGENT_TIMEOUT_SECONDS. The Vercel function running it is
 * stopped after 300 s anyway.
 */
const LEASE_MS = 6 * 60_000;
/** After a refresh that produced nothing, wait this long before trying again. */
const RETRY_AFTER_FAILURE_MS = 2 * 60_000;
/** A selection older than this is reported as "degraded". */
const STALE_AFTER_MS = 3 * REFRESH_MINUTES * 60_000;

/** How the last curation went: who produced it (null if nobody did) and everyone who was tried. */
type AgentReport = { at: string; agent: FeedAgentName | null; model: string | null; ms: number | null; ok: boolean; error: string | null; attempts: AgentAttempt[] };

type Stored = {
  version: number;
  items: FeedItem[];
  updatedAt: string | null;
  curation: "agent" | "fallback";
  sources: FeedSourceStatus[];
  /** Ids of the last HISTORY_SELECTIONS selections, newest first. */
  history: string[][];
  /** Diagnostics for the last curation call; not part of the API. */
  agent: AgentReport | null;
  /** Whether the last refresh produced a selection, and why not. */
  lastRefreshFailed?: boolean;
  lastError?: string | null;
};

// On globalThis so every copy of this module (route bundles, dev-mode reloads) shares one copy.
type Runtime = {
  state: Stored;
  loading: Promise<void> | null;
  /** When the selection was last read from the store. */
  loadedAt: number;
  /** True while this instance is refreshing. */
  refreshing: boolean;
  caches: Map<string, SourceCache>;
};

function emptyState(): Stored {
  return { version: STATE_VERSION, items: [], updatedAt: null, curation: "fallback", sources: [], history: [], agent: null, lastRefreshFailed: false, lastError: null };
}

const globalStore = globalThis as typeof globalThis & { __babFeed?: Runtime };
const runtime: Runtime = (globalStore.__babFeed ??= {
  state: emptyState(),
  loading: null,
  loadedAt: 0,
  refreshing: false,
  caches: new Map(),
});

function refreshMs(): number {
  const minutes = Number(process.env.FEED_REFRESH_MINUTES);
  return (Number.isFinite(minutes) && minutes >= 5 ? minutes : REFRESH_MINUTES) * 60_000;
}

const isItem = (value: unknown): value is FeedItem => {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    (item.kind === "news" || item.kind === "tweet") &&
    typeof item.source === "string" &&
    typeof item.title === "string" &&
    typeof item.url === "string" &&
    /^https?:\/\//.test(item.url) &&
    typeof item.publishedAt === "string" &&
    Number.isFinite(Date.parse(item.publishedAt))
  );
};

/**
 * Reads feed.json from the store once, and again when another instance may have renewed it. A
 * missing, old or damaged document just means starting empty.
 */
function load(force = false): Promise<void> {
  if (runtime.loading) return runtime.loading;
  if (!force && (runtime.refreshing || (runtime.loadedAt > 0 && Date.now() - runtime.loadedAt < reloadAfterMs()))) return Promise.resolve();
  return (runtime.loading = (async () => {
    const stored = await readJson<Partial<Stored>>(STATE_FILE);
    runtime.loadedAt = Date.now();
    if (!stored || stored.version !== STATE_VERSION) return;
    const state = emptyState();
    if (Array.isArray(stored.items)) state.items = stored.items.filter(isItem).slice(0, MAX_ITEMS);
    if (typeof stored.updatedAt === "string" && Number.isFinite(Date.parse(stored.updatedAt))) state.updatedAt = stored.updatedAt;
    if (stored.curation === "agent") state.curation = "agent";
    if (Array.isArray(stored.sources)) state.sources = stored.sources;
    if (Array.isArray(stored.history)) {
      state.history = stored.history
        .filter(Array.isArray)
        .slice(0, HISTORY_SELECTIONS)
        .map((ids) => ids.filter((id): id is string => typeof id === "string"));
    }
    if (stored.agent && typeof stored.agent === "object") state.agent = stored.agent;
    state.lastRefreshFailed = stored.lastRefreshFailed === true;
    state.lastError = typeof stored.lastError === "string" ? stored.lastError : null;
    if (!state.items.length) state.updatedAt = null;
    runtime.state = state;
  })().finally(() => {
    runtime.loading = null;
  }));
}

async function save(): Promise<void> {
  try {
    await writeJson(STATE_FILE, runtime.state);
  } catch (error) {
    console.warn("[feed] could not save feed.json:", error instanceof Error ? error.message : error);
  }
}

/** A story carried by at least this many sources may stay on screen two selections running. */
const MAJOR_STORY_OUTLETS = 3;

/**
 * Newest items of every source, deduped across outlets and capped so one prompt holds them all.
 * `outlets` says how many sources carried each story that more than one did.
 *
 * Rotation is built in here rather than left to the model: whatever was in the last selection
 * (`lastShown`) is not offered again this time, except stories big enough to be covered by
 * MAJOR_STORY_OUTLETS sources. When that would leave too little to choose from, everything is
 * offered and the "shown" marks in the prompt do the work.
 */
export function buildCandidates(results: SourceResult[], lastShown: string[] = []): { pool: FeedItem[]; outlets: Map<string, number> } {
  const newestFirst = (a: FeedItem, b: FeedItem) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  const stories = cluster(results.flatMap((result) => result.items));
  const outlets = new Map(stories.filter((story) => story.outlets > 1).map((story) => [story.item.id, story.outlets]));
  const shown = new Set(lastShown);
  const rested = stories.filter((story) => !shown.has(story.item.id) || story.outlets >= MAJOR_STORY_OUTLETS);
  const offered = rested.length >= 2 * TARGET_ITEMS ? rested : stories;
  const groups = new Map<string, FeedItem[]>();
  const perAccount = new Map<string, number>();
  for (const item of offered.map((story) => story.item).sort(newestFirst)) {
    if (item.kind === "tweet") {
      // One prolific account must not use up the network's whole share of the candidate list.
      const account = `${item.source} ${item.handle ?? ""}`;
      const count = (perAccount.get(account) ?? 0) + 1;
      perAccount.set(account, count);
      if (count > PER_ACCOUNT_CANDIDATES) continue;
    }
    const group = groups.get(item.source);
    if (!group) groups.set(item.source, [item]);
    else if (group.length < PER_SOURCE_CANDIDATES) group.push(item);
  }
  // Take turns between sources so the cap cannot squeeze a quiet source out.
  const picked: FeedItem[] = [];
  for (let round = 0; round < PER_SOURCE_CANDIDATES && picked.length < MAX_CANDIDATES; round += 1) {
    for (const group of groups.values()) {
      if (group[round] && picked.length < MAX_CANDIDATES) picked.push(group[round]);
    }
  }
  return { pool: picked.sort(newestFirst), outlets };
}

function publish(ids: string[], pool: FeedItem[], curation: "agent" | "fallback", now: number, remember: boolean) {
  const byId = new Map(pool.map((item) => [item.id, item]));
  const items = ids.map((id) => byId.get(id)).filter((item): item is FeedItem => Boolean(item)).slice(0, MAX_ITEMS);
  if (!items.length) return;
  const state = runtime.state;
  state.items = items;
  state.curation = curation;
  state.updatedAt = new Date(now).toISOString();
  if (remember) state.history = [items.map((item) => item.id), ...state.history].slice(0, HISTORY_SELECTIONS);
}

async function refresh(): Promise<void> {
  const now = Date.now();
  const state = runtime.state;
  const results = await gatherSources({ now, caches: runtime.caches });
  state.sources = results.map(({ name, kind, ok, items, error }) => ({ name, kind, ok, items: items.length, error }));
  const { pool, outlets } = buildCandidates(results, state.history[0]);
  if (!pool.length) {
    // Nothing usable: keep whatever is on screen and say why.
    state.lastRefreshFailed = true;
    state.lastError = results.some((result) => result.ok) ? "no recent items in any source" : "no source could be reached";
    await save();
    return;
  }
  state.lastRefreshFailed = false;
  state.lastError = null;

  // First selection ever: put the plain ordering up now rather than wait for the model.
  if (!state.items.length) publish(fallbackOrder(pool, state.history), pool, "fallback", now, false);

  try {
    const outcome = await pickWithAgent(pool, state.history, now, outlets);
    publish(outcome.ids, pool, "agent", Date.now(), true);
    state.agent = { at: new Date().toISOString(), agent: outcome.agent, model: outcome.model, ms: outcome.ms, ok: true, error: null, attempts: outcome.attempts };
  } catch (error) {
    const code = error instanceof AgentError ? error.code : "internal_error";
    publish(fallbackOrder(pool, state.history), pool, "fallback", Date.now(), true);
    state.agent = { at: new Date().toISOString(), agent: null, model: null, ms: null, ok: false, error: code, attempts: error instanceof AgentError ? error.attempts : [] };
    if (agentPlan().order.length) console.warn(`[feed] AI curation failed (${code}); using the fallback ordering`);
  }
  await save();
  // The newsworthy tokens are chosen from the same fetch, after the feed is up. It keeps its own
  // schedule (not every refresh) and its own state, and never rejects.
  await refreshNewsworthy(results, Date.now());
}

export const feedJob: JobSpec = {
  name: "feed",
  leaseMs: LEASE_MS,
  everyMs: refreshMs,
  retryMs: RETRY_AFTER_FAILURE_MS,
  // Nobody is looking: no fetches, no model calls.
  idleAfterMs: IDLE_PAUSE_MINUTES * 60_000,
  run: async () => {
    runtime.refreshing = true;
    try {
      await load(true);
      await refresh();
    } catch (error) {
      runtime.state.lastRefreshFailed = true;
      runtime.state.lastError = "refresh failed";
      await save();
      throw error;
    } finally {
      runtime.refreshing = false;
    }
    return runtime.state.lastRefreshFailed ? RETRY_AFTER_FAILURE_MS : refreshMs();
  },
};

/**
 * Runs one refresh if one is due and no other instance is running one. Never rejects. `force`
 * skips the interval check; it is for scripts and tests, not for the route.
 */
export async function refreshFeed(options: { force?: boolean } = {}): Promise<void> {
  await runJob(feedJob, options);
}

function response(): FeedResponse {
  const state = runtime.state;
  const picked = state.curation === "agent" && state.agent?.ok ? state.agent : null;
  const base = {
    items: state.items,
    updatedAt: state.updatedAt,
    sources: state.sources,
    curation: state.curation,
    agent: picked?.agent ?? null,
    agentModel: picked?.model ?? null,
  };
  if (!state.items.length) {
    if (state.lastRefreshFailed) return { status: "error", ...base, message: state.lastError ?? "refresh failed" };
    return { status: "empty", ...base, message: "First refresh in progress" };
  }
  const failing = state.sources.filter((source) => !source.ok);
  const stale = state.updatedAt !== null && Date.now() - Date.parse(state.updatedAt) > STALE_AFTER_MS;
  const notes = [
    stale ? "selection is stale" : null,
    state.lastRefreshFailed ? (state.lastError ?? "last refresh failed") : null,
    failing.length ? `${failing.length} source${failing.length === 1 ? "" : "s"} failing: ${failing.map((source) => source.name).join(", ")}` : null,
    state.curation === "fallback" && state.agent?.error && state.agent.error !== "agent_off" ? `AI curation unavailable (${state.agent.error}); showing the newest items` : null,
  ].filter(Boolean);
  const degraded = stale || state.lastRefreshFailed === true || failing.length > 0;
  return { status: degraded ? "degraded" : "ok", ...base, ...(notes.length ? { message: notes.join("; ") } : {}) };
}

/**
 * The current selection, immediately. If the selection is due, starts a refresh in the background;
 * the caller gets what is in memory now and a later poll gets the new one.
 */
export async function getFeed(): Promise<FeedResponse> {
  try {
    await load();
  } catch {
    // Start empty.
  }
  // A screen is watching; the job skips its rounds when none has for a while.
  inBackground(noteDemand(feedJob.name).then(() => runJob(feedJob)));
  return response();
}
