// Fetchers for the feed's sources: RSS/Atom, Hacker News, Bluesky and X. Each returns a
// SourceResult and never throws, so one broken source cannot sink a refresh.

import {
  BLUESKY,
  FETCH_CONCURRENCY,
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  HACKER_NEWS,
  MAX_AGE_HOURS,
  NEWS_FEEDS,
  USER_AGENT,
  X,
  type RssSource,
} from "./feed-sources";
import { canonicalUrl, clip, decodeEntities, httpsImage, makeId, parseFeed, rejectReason, tidy } from "./feed-parse";
import type { FeedItem, FeedKind } from "./feed-types";

export type SourceResult = {
  name: string;
  kind: FeedKind;
  ok: boolean;
  items: FeedItem[];
  error: string | null;
};

/** What is remembered about one HTTP source between refreshes. */
export type SourceCache = {
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  items: FeedItem[];
};

/** X state that survives restarts: lookups and reads cost money, so nothing is fetched twice. */
export type XState = {
  /** Lower-cased handle -> account. */
  users: Record<string, { id: string; name: string; username: string }>;
  /** User id -> newest post id seen. */
  sinceIds: Record<string, string>;
  posts: FeedItem[];
  /** UTC day (YYYY-MM-DD) the read counter belongs to. */
  day: string;
  readsToday: number;
  fetchedAt: number;
  /** Handles X did not recognise. */
  unknown: string[];
};

export function emptyXState(): XState {
  return { users: {}, sinceIds: {}, posts: [], day: "", readsToday: 0, fetchedAt: 0, unknown: [] };
}

export type FetchContext = {
  now: number;
  caches: Map<string, SourceCache>;
  x: XState;
};

const POST_MAX = 400;
const POST_MIN = 30;

class HttpError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

function errorCode(error: unknown): string {
  if (error instanceof HttpError) return error.code;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "network_error";
}

/** Reads at most `limit` bytes of a body, so a runaway response cannot fill memory. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return (await response.text()).slice(0, limit);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError("too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: string }> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
    cache: "no-store",
  });
  if (response.status === 304) return { status: 304, headers: response.headers, body: "" };
  return { status: response.status, headers: response.headers, body: await readCapped(response, FETCH_MAX_BYTES) };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const response = await get(url, { Accept: "application/json", ...headers });
  if (response.status < 200 || response.status >= 300) throw new HttpError(`http_${response.status}`);
  try {
    return JSON.parse(response.body);
  } catch {
    throw new HttpError("bad_json");
  }
}

async function mapLimit<T, R>(inputs: T[], limit: number, worker: (input: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, inputs.length) }, async () => {
      while (next < inputs.length) {
        const index = next++;
        results[index] = await worker(inputs[index]);
      }
    }),
  );
  return results;
}

const fresh = (items: FeedItem[], now: number, maxAgeHours: number) =>
  items.filter((item) => now - Date.parse(item.publishedAt) <= maxAgeHours * 3_600_000);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

// --- RSS / Atom ----------------------------------------------------------------------------------

async function fetchRss(source: RssSource, context: FetchContext): Promise<SourceResult> {
  const maxAge = source.maxAgeHours ?? MAX_AGE_HOURS;
  const cache = context.caches.get(source.name);
  const cached = () => fresh(cache?.items ?? [], context.now, maxAge);
  if (cache && source.everyMinutes && context.now - cache.fetchedAt < source.everyMinutes * 60_000 - 30_000) {
    return { name: source.name, kind: "news", ok: true, items: cached(), error: null };
  }
  try {
    const conditional: Record<string, string> = { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5" };
    if (cache?.etag) conditional["If-None-Match"] = cache.etag;
    if (cache?.lastModified) conditional["If-Modified-Since"] = cache.lastModified;
    const response = await get(source.url, conditional);
    if (response.status === 304 && cache) {
      cache.fetchedAt = context.now;
      return { name: source.name, kind: "news", ok: true, items: cached(), error: null };
    }
    if (response.status < 200 || response.status >= 300) throw new HttpError(`http_${response.status}`);
    const parsed = parseFeed(response.body, source.name, context.now);
    if (!parsed.recognised) throw new HttpError("not_a_feed");
    const items: FeedItem[] = [];
    for (const { categories, ...item } of fresh(parsed.entries, context.now, maxAge) as (FeedItem & { categories: string[] })[]) {
      if (!rejectReason(item, categories)) items.push(item);
    }
    context.caches.set(source.name, {
      etag: response.headers.get("etag") ?? undefined,
      lastModified: response.headers.get("last-modified") ?? undefined,
      fetchedAt: context.now,
      items,
    });
    return { name: source.name, kind: "news", ok: true, items, error: null };
  } catch (error) {
    // Keep showing what the last good fetch had while the source is down.
    return { name: source.name, kind: "news", ok: false, items: cached(), error: errorCode(error) };
  }
}

// --- Hacker News ---------------------------------------------------------------------------------

async function fetchHackerNews(context: FetchContext): Promise<SourceResult> {
  const name = HACKER_NEWS.name;
  try {
    const data = await getJson(HACKER_NEWS.url);
    const hits = isRecord(data) && Array.isArray(data.hits) ? data.hits : null;
    if (!hits) throw new HttpError("unexpected_shape");
    const items: FeedItem[] = [];
    for (const hit of hits) {
      if (!isRecord(hit)) continue;
      const title = text(hit.title);
      const id = text(hit.objectID) ?? (typeof hit.story_id === "number" ? String(hit.story_id) : null);
      const published = Date.parse(text(hit.created_at) ?? "");
      if (!title || !id || !/^\d+$/.test(id) || !Number.isFinite(published)) continue;
      if (typeof hit.points !== "number" || hit.points < HACKER_NEWS.minPoints) continue;
      const item: FeedItem = {
        id: makeId(name, id),
        kind: "news",
        source: name,
        author: null,
        handle: null,
        title: clip(tidy(decodeEntities(title)), 220),
        summary: null,
        url: canonicalUrl(text(hit.url)) ?? `https://news.ycombinator.com/item?id=${id}`,
        publishedAt: new Date(Math.min(published, context.now)).toISOString(),
        imageUrl: null,
      };
      if (!rejectReason(item)) items.push(item);
    }
    const kept = fresh(items, context.now, MAX_AGE_HOURS);
    context.caches.set(name, { fetchedAt: context.now, items: kept });
    return { name, kind: "news", ok: true, items: kept, error: null };
  } catch (error) {
    const cached = fresh(context.caches.get(name)?.items ?? [], context.now, MAX_AGE_HOURS);
    return { name, kind: "news", ok: false, items: cached, error: errorCode(error) };
  }
}

// --- Bluesky -------------------------------------------------------------------------------------

/** Post text with each link facet (shown truncated, "example.com/a-long-pa...") replaced by its host. */
function blueskyText(record: Record<string, unknown>): string {
  const raw = text(record.text) ?? "";
  const facets = Array.isArray(record.facets) ? record.facets : [];
  const links: { start: number; end: number; host: string }[] = [];
  for (const facet of facets) {
    if (!isRecord(facet) || !isRecord(facet.index) || !Array.isArray(facet.features)) continue;
    const { byteStart, byteEnd } = facet.index;
    if (typeof byteStart !== "number" || typeof byteEnd !== "number" || byteEnd <= byteStart) continue;
    for (const feature of facet.features) {
      if (!isRecord(feature) || feature.$type !== "app.bsky.richtext.facet#link") continue;
      try {
        links.push({ start: byteStart, end: byteEnd, host: new URL(String(feature.uri)).hostname.replace(/^www\./, "") });
      } catch {
        // Not a URL; leave the text as written.
      }
    }
  }
  if (!links.length) return tidy(raw);
  // Facet offsets are UTF-8 byte positions.
  const bytes = Buffer.from(raw, "utf8");
  let out = "";
  let at = 0;
  for (const link of links.sort((a, b) => a.start - b.start)) {
    if (link.start < at || link.end > bytes.length) continue;
    out += bytes.subarray(at, link.start).toString("utf8") + link.host;
    at = link.end;
  }
  return tidy(out + bytes.subarray(at).toString("utf8"));
}

function blueskyPosts(data: unknown, now: number): FeedItem[] {
  const feed = isRecord(data) && Array.isArray(data.feed) ? data.feed : null;
  if (!feed) throw new HttpError("unexpected_shape");
  const items: FeedItem[] = [];
  for (const entry of feed) {
    if (!isRecord(entry) || entry.reason || entry.reply) continue; // reposts and replies
    const post = entry.post;
    if (!isRecord(post) || !isRecord(post.record) || !isRecord(post.author)) continue;
    const record = post.record;
    if (record.reply) continue;
    // Anything carrying a moderation or self-applied content label stays off the wall.
    if (Array.isArray(post.labels) && post.labels.length) continue;
    if (isRecord(record.labels) && Array.isArray(record.labels.values) && record.labels.values.length) continue;
    if (Array.isArray(record.langs) && record.langs.length && !record.langs.some((lang) => typeof lang === "string" && lang.toLowerCase().startsWith("en"))) continue;
    const handle = text(post.author.handle);
    const uri = text(post.uri);
    const published = Date.parse(text(record.createdAt) ?? "");
    const key = uri ? uri.split("/").pop() : null;
    if (!handle || !uri || !key || !/^[a-z0-9.-]+$/i.test(handle) || !/^[a-z0-9]+$/i.test(key) || !Number.isFinite(published)) continue;
    const body = blueskyText(record);
    if (body.length < POST_MIN) continue;
    const embed = isRecord(post.embed) ? post.embed : null;
    const firstImage = embed && Array.isArray(embed.images) && isRecord(embed.images[0]) ? text(embed.images[0].thumb) : null;
    const external = embed && isRecord(embed.external) ? text(embed.external.thumb) : null;
    const item: FeedItem = {
      id: makeId(BLUESKY.name, uri),
      kind: "tweet",
      source: BLUESKY.name,
      author: text(post.author.displayName) ? tidy(String(post.author.displayName)) : handle,
      handle: `@${handle}`,
      title: clip(body, POST_MAX),
      summary: null,
      url: `https://bsky.app/profile/${handle}/post/${key}`,
      publishedAt: new Date(Math.min(published, now)).toISOString(),
      imageUrl: httpsImage(firstImage ?? external),
    };
    if (!rejectReason(item)) items.push(item);
  }
  return items;
}

async function fetchBluesky(context: FetchContext): Promise<SourceResult> {
  const name = BLUESKY.name;
  const failures: string[] = [];
  const perAccount = await mapLimit(BLUESKY.accounts, 3, async (actor) => {
    const key = `${name}:${actor}`;
    try {
      const url = `${BLUESKY.api}?actor=${encodeURIComponent(actor)}&limit=${BLUESKY.postsPerAccount}&filter=posts_no_replies`;
      const items = fresh(blueskyPosts(await getJson(url), context.now), context.now, BLUESKY.maxAgeHours);
      context.caches.set(key, { fetchedAt: context.now, items });
      return items;
    } catch (error) {
      failures.push(`${actor}: ${errorCode(error)}`);
      return fresh(context.caches.get(key)?.items ?? [], context.now, BLUESKY.maxAgeHours);
    }
  });
  const allFailed = failures.length === BLUESKY.accounts.length && BLUESKY.accounts.length > 0;
  return {
    name,
    kind: "tweet",
    ok: !allFailed,
    items: perAccount.flat(),
    error: failures.length ? clip(`${failures.length} of ${BLUESKY.accounts.length} accounts failed (${failures.join(", ")})`, 200) : null,
  };
}

// --- X -------------------------------------------------------------------------------------------

const X_TWEET_FIELDS = "tweet.fields=created_at,author_id,lang,possibly_sensitive,referenced_tweets,note_tweet,entities,attachments";
const X_EXPANSIONS = "expansions=author_id,attachments.media_keys&user.fields=name,username&media.fields=type,url,preview_image_url";

export function xConfig(): { token: string | null; listId: string | null; maxReadsPerDay: number } {
  const token = process.env.X_BEARER_TOKEN?.trim() || null;
  const list = (process.env.X_LIST_ID ?? X.listId).trim();
  const budget = Number(process.env.X_MAX_READS_PER_DAY);
  return {
    token,
    listId: /^\d+$/.test(list) ? list : null,
    maxReadsPerDay: Number.isFinite(budget) && budget >= 0 ? Math.floor(budget) : X.maxReadsPerDay,
  };
}

function xPostText(tweet: Record<string, unknown>): string {
  const note = isRecord(tweet.note_tweet) ? tweet.note_tweet : null;
  let body = text(note?.text) ?? text(tweet.text) ?? "";
  const entities = isRecord(note?.entities) ? note.entities : isRecord(tweet.entities) ? tweet.entities : null;
  const urls = entities && Array.isArray(entities.urls) ? entities.urls : [];
  for (const entry of urls) {
    if (!isRecord(entry)) continue;
    const short = text(entry.url);
    const expanded = text(entry.expanded_url) ?? "";
    if (!short) continue;
    // Links to the post's own media or to a quoted post add nothing on a wall; others show their host.
    let replacement = "";
    try {
      const target = new URL(expanded);
      const own = /(^|\.)(x|twitter)\.com$/i.test(target.hostname) && /\/(status|photo|video)\//.test(target.pathname);
      if (!own) replacement = target.hostname.replace(/^www\./, "");
    } catch {
      replacement = "";
    }
    body = body.split(short).join(replacement);
  }
  return tidy(decodeEntities(body.replace(/https:\/\/t\.co\/\w+/g, "")));
}

/** Maps one X API v2 posts payload ({ data, includes }) to feed items. */
function xPosts(payload: unknown, now: number): { items: FeedItem[]; reads: number; newestId: string | null } {
  if (!isRecord(payload)) throw new HttpError("unexpected_shape");
  const data = Array.isArray(payload.data) ? payload.data : [];
  const includes = isRecord(payload.includes) ? payload.includes : {};
  const users = new Map<string, { name: string; username: string }>();
  for (const user of Array.isArray(includes.users) ? includes.users : []) {
    if (isRecord(user) && text(user.id) && text(user.username)) {
      users.set(String(user.id), { name: text(user.name) ?? String(user.username), username: String(user.username) });
    }
  }
  const media = new Map<string, string>();
  for (const entry of Array.isArray(includes.media) ? includes.media : []) {
    if (!isRecord(entry) || !text(entry.media_key)) continue;
    const image = httpsImage(text(entry.url) ?? text(entry.preview_image_url));
    if (image) media.set(String(entry.media_key), image);
  }
  const items: FeedItem[] = [];
  let newestId: string | null = null;
  for (const tweet of data) {
    if (!isRecord(tweet)) continue;
    const id = text(tweet.id);
    if (!id || !/^\d+$/.test(id)) continue;
    if (!newestId || BigInt(id) > BigInt(newestId)) newestId = id;
    const author = users.get(String(tweet.author_id));
    const published = Date.parse(text(tweet.created_at) ?? "");
    if (!author || !/^\w{1,15}$/.test(author.username) || !Number.isFinite(published)) continue;
    if (tweet.possibly_sensitive === true) continue;
    const references = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
    if (references.some((reference) => isRecord(reference) && (reference.type === "retweeted" || reference.type === "replied_to"))) continue;
    const lang = text(tweet.lang);
    if (lang && !["en", "und", "qme", "zxx"].includes(lang)) continue;
    const body = xPostText(tweet);
    if (body.length < POST_MIN) continue;
    const keys = isRecord(tweet.attachments) && Array.isArray(tweet.attachments.media_keys) ? tweet.attachments.media_keys : [];
    const image = keys.map((key) => media.get(String(key))).find(Boolean) ?? null;
    const item: FeedItem = {
      id: makeId(X.name, id),
      kind: "tweet",
      source: X.name,
      author: tidy(author.name),
      handle: `@${author.username}`,
      title: clip(body, POST_MAX),
      summary: null,
      url: `https://x.com/${author.username}/status/${id}`,
      publishedAt: new Date(Math.min(published, now)).toISOString(),
      imageUrl: image,
    };
    if (!rejectReason(item)) items.push(item);
  }
  return { items, reads: data.length, newestId };
}

function xError(error: unknown): string {
  const code = errorCode(error);
  if (code === "http_401") return "http_401 (X rejected X_BEARER_TOKEN)";
  if (code === "http_402") return "http_402 (the X developer account has no credits)";
  if (code === "http_403") return "http_403 (the X app may not read this; check its access level)";
  if (code === "http_429") return "http_429 (X rate limit)";
  return code;
}

async function fetchX(context: FetchContext): Promise<SourceResult> {
  const name = X.name;
  const config = xConfig();
  if (!config.token) {
    return { name, kind: "tweet", ok: false, items: [], error: "not configured: set X_BEARER_TOKEN (X has no free read tier)" };
  }
  const state = context.x;
  const today = new Date(context.now).toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.readsToday = 0;
  }
  const cached = () => {
    state.posts = fresh(state.posts, context.now, X.maxAgeHours);
    return state.posts;
  };
  if (state.fetchedAt && context.now - state.fetchedAt < X.everyMinutes * 60_000 - 30_000) {
    return { name, kind: "tweet", ok: true, items: cached(), error: null };
  }
  const authorization = { Authorization: `Bearer ${config.token}` };
  const remaining = () => config.maxReadsPerDay - state.readsToday;
  const overBudget = `daily budget of ${config.maxReadsPerDay} post reads reached; resumes at 00:00 UTC`;
  const merge = (items: FeedItem[]) => {
    const known = new Set(state.posts.map((post) => post.id));
    state.posts.push(...items.filter((item) => !known.has(item.id)));
  };
  try {
    if (config.listId) {
      const want = Math.min(X.postsPerList, remaining());
      if (want < 1) return { name, kind: "tweet", ok: true, items: cached(), error: overBudget };
      const payload = await getJson(`${X.api}/lists/${config.listId}/tweets?max_results=${want}&${X_TWEET_FIELDS}&${X_EXPANSIONS}`, authorization);
      const { items, reads } = xPosts(payload, context.now);
      state.readsToday += reads;
      state.fetchedAt = context.now;
      merge(items);
      return { name, kind: "tweet", ok: true, items: cached(), error: null };
    }

    // Accounts mode. Handles are resolved to ids once and remembered.
    const handles = X.accounts.map((handle) => handle.replace(/^@/, "").trim()).filter((handle) => /^\w{1,15}$/.test(handle));
    const unresolved = handles.filter((handle) => !state.users[handle.toLowerCase()] && !state.unknown.includes(handle.toLowerCase()));
    for (let at = 0; at < unresolved.length; at += 100) {
      const batch = unresolved.slice(at, at + 100);
      const payload = await getJson(`${X.api}/users/by?usernames=${batch.join(",")}&user.fields=name,username`, authorization);
      const found = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
      for (const user of found) {
        if (isRecord(user) && text(user.id) && text(user.username)) {
          state.users[String(user.username).toLowerCase()] = { id: String(user.id), name: text(user.name) ?? String(user.username), username: String(user.username) };
        }
      }
      for (const handle of batch) if (!state.users[handle.toLowerCase()]) state.unknown.push(handle.toLowerCase());
    }

    const accounts = handles.map((handle) => state.users[handle.toLowerCase()]).filter(Boolean);
    const failures: string[] = [];
    let stopped = false;
    await mapLimit(accounts, 3, async (account) => {
      // Each request can return postsPerAccount posts; stop before the budget can be overrun.
      if (remaining() < X.postsPerAccount) {
        stopped = true;
        return;
      }
      state.readsToday += X.postsPerAccount; // reserved, corrected below
      try {
        const since = state.sinceIds[account.id];
        const window = since ? `since_id=${since}` : `start_time=${new Date(context.now - X.maxAgeHours * 3_600_000).toISOString().replace(/\.\d+Z$/, "Z")}`;
        const payload = await getJson(
          `${X.api}/users/${account.id}/tweets?max_results=${X.postsPerAccount}&exclude=retweets,replies&${window}&${X_TWEET_FIELDS}&${X_EXPANSIONS}`,
          authorization,
        );
        const { items, reads, newestId } = xPosts(payload, context.now);
        state.readsToday += reads - X.postsPerAccount;
        if (newestId) state.sinceIds[account.id] = newestId;
        merge(items);
      } catch (error) {
        state.readsToday -= X.postsPerAccount;
        failures.push(`@${account.username}: ${xError(error)}`);
      }
    });
    state.fetchedAt = context.now;
    const notes = [
      failures.length ? `${failures.length} of ${accounts.length} accounts failed (${failures.slice(0, 3).join(", ")})` : null,
      state.unknown.length ? `unknown handles: ${state.unknown.join(", ")}` : null,
      stopped ? overBudget : null,
    ].filter(Boolean);
    return {
      name,
      kind: "tweet",
      ok: accounts.length > 0 && failures.length < accounts.length,
      items: cached(),
      error: notes.length ? clip(notes.join("; "), 240) : null,
    };
  } catch (error) {
    return { name, kind: "tweet", ok: false, items: cached(), error: xError(error) };
  }
}

// --- All sources ---------------------------------------------------------------------------------

/** Fetches every configured source once. Never throws. The order is the order of `sources` in the API. */
export async function gatherSources(context: FetchContext): Promise<SourceResult[]> {
  const jobs: (() => Promise<SourceResult>)[] = [
    ...NEWS_FEEDS.map((source) => () => fetchRss(source, context)),
    () => fetchHackerNews(context),
  ];
  if ((process.env.FEED_BLUESKY ?? "").toLowerCase() !== "off" && BLUESKY.accounts.length) jobs.push(() => fetchBluesky(context));
  jobs.push(() => fetchX(context));
  return mapLimit(jobs, FETCH_CONCURRENCY, async (job) => {
    try {
      return await job();
    } catch {
      return { name: "unknown", kind: "news" as const, ok: false, items: [], error: "internal_error" };
    }
  });
}
