// The club in the news, for the feed column's spotlight (app/Feed.tsx). Two ways in:
//
//   - Found: every news article the feed fetches is read once, page and all, and kept if it names someone in the
//     club's Slack (lib/club-roster.ts) and mentions Berkeley, or names the club itself. A name often appears only
//     in the article body or a photo caption, never in the feed's headline or summary, which is why the page is
//     read. A Google News search for the club's name adds coverage from outlets the feed does not follow.
//   - Shared: "@bot spotlight <link> <who it is about>" in the songs channel (lib/commands.ts). For stories that
//     never name the person, like a launch post by a co-founder.
//
// Nothing here is written by a model: the screen shows the publisher's headline and opening lines, or the post.
// Runs inside the feed's refresh (lib/feed.ts), after the feed is up. State is kept in .data/club-news.json.

import { mapLimit, fetchPage, type SourceResult } from "./feed-fetch";
import { clip, makeId, parseFeed, tidy } from "./feed-parse";
import { HACKER_NEWS } from "./feed-sources";
import type { ClubNewsResponse, ClubStory, FeedItem } from "./feed-types";
import { getRoster } from "./club-roster";
import { pageFacts, previewLink } from "./link-preview";
import { resolveUserName } from "./slack-users";
import { readJson, writeJson } from "./songs-store";

/** A story found in the news is in the spotlight for this long after it was published. */
const FOUND_DAYS = 7;
/** A story shared in Slack is in the spotlight for this long after it was shared. */
const SHARED_DAYS = 3;
const MAX_STORIES = 6;
/** New articles read per refresh, and how many at once; the rest wait for the next refresh. */
const READ_PER_RUN = 30;
const READ_CONCURRENCY = 4;
const SUMMARY_MAX = 260;
const ABOUT_MAX = 60;
const STATE_FILE = "club-news.json";
const STATE_VERSION = 1;

/** Coverage of the club from outlets the feed does not follow. Every result names the club, so none is read. */
const CLUB_SEARCH = {
  name: "Google News",
  url: "https://news.google.com/rss/search?q=%22Blockchain+at+Berkeley%22&hl=en-US&gl=US&ceid=US:en",
  everyMinutes: 60,
};
const CLUB_NAME = /Blockchain at Berkeley|(?<![\p{L}\p{N}])B@B(?![\p{L}\p{N}])/u;
const BERKELEY = /Berkeley/;

/** What reading one article found. Kept per item id so an article is read once. */
type Reading = { at: number; people: string[]; club: boolean; imageUrl: string | null; description: string | null };
type Shared = { story: ClubStory; sharedAt: number };
type State = {
  version: number;
  readings: Record<string, Reading>;
  found: ClubStory[];
  shared: Shared[];
  searchedAt: number;
  searchItems: FeedItem[];
  updatedAt: string | null;
};

const emptyState = (): State => ({ version: STATE_VERSION, readings: {}, found: [], shared: [], searchedAt: 0, searchItems: [], updatedAt: null });
type Runtime = { state: State; loaded: Promise<void> | null; running: Promise<void> | null };
const shared = globalThis as { __babClubNews?: Runtime };
const runtime: Runtime = (shared.__babClubNews ??= { state: emptyState(), loaded: null, running: null });

function load(): Promise<void> {
  return (runtime.loaded ??= (async () => {
    const stored = await readJson<Partial<State>>(STATE_FILE);
    if (stored?.version === STATE_VERSION) runtime.state = { ...emptyState(), ...stored };
  })());
}

async function save(): Promise<void> {
  try {
    await writeJson(STATE_FILE, runtime.state);
  } catch (error) {
    console.warn("[club-news] could not save .data/club-news.json:", error instanceof Error ? error.message : error);
  }
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Finds the roster's names in a text. A name counts only as a whole name, and only in a text about Berkeley. */
export function makeMatcher(roster: string[]): (text: string) => string[] {
  const patterns = roster.map((name) => ({ name, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "u") }));
  return (text) => (BERKELEY.test(text) ? patterns.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name) : []);
}

/** Reads an article's page and looks for the club and its people in it, the headline and the summary. */
async function readArticle(item: FeedItem, findPeople: (text: string) => string[], now: number): Promise<Reading> {
  const html = await fetchPage(item.url);
  const facts = html ? pageFacts(html) : null;
  const text = [item.title, item.summary ?? "", facts?.text ?? ""].join("\n");
  return { at: now, people: findPeople(text), club: CLUB_NAME.test(text), imageUrl: facts?.imageUrl ?? null, description: facts?.description ?? null };
}

async function searchClub(state: State, now: number): Promise<FeedItem[]> {
  if (now - state.searchedAt < CLUB_SEARCH.everyMinutes * 60_000) return state.searchItems;
  const xml = await fetchPage(CLUB_SEARCH.url);
  if (!xml) return state.searchItems;
  state.searchedAt = now;
  state.searchItems = parseFeed(xml, CLUB_SEARCH.name, now).entries.map(({ categories: _categories, ...item }) => item);
  return state.searchItems;
}

/** Google News headlines end in " - Outlet"; the outlet is the story's source. */
function splitOutlet(item: FeedItem): { title: string; source: string } {
  if (item.source !== CLUB_SEARCH.name) return { title: item.title, source: item.source };
  const cut = item.title.lastIndexOf(" - ");
  return cut > 0 ? { title: item.title.slice(0, cut), source: item.title.slice(cut + 3) } : { title: item.title, source: item.source };
}

function storyFrom(item: FeedItem, reading: Reading): ClubStory {
  const { title, source } = splitOutlet(item);
  const summary = item.summary ? clip(tidy(item.summary), SUMMARY_MAX) : reading.description;
  return { id: item.id, title, summary, source, url: item.url, imageUrl: reading.imageUrl ?? item.imageUrl, publishedAt: item.publishedAt, people: reading.people, via: "news", sharedBy: null };
}

const recent = (item: FeedItem, now: number) => now - Date.parse(item.publishedAt) < FOUND_DAYS * 86_400_000;

function newsItems(results: SourceResult[], now: number): FeedItem[] {
  return results
    .filter((result) => result.kind === "news" && result.name !== HACKER_NEWS.name)
    .flatMap((result) => result.items)
    .filter((item) => item.kind === "news" && recent(item, now));
}

async function readNew(items: FeedItem[], state: State, now: number): Promise<void> {
  const roster = await getRoster(now);
  // Without the roster nobody can be found, and an article is read only once: wait until Slack answers.
  if (!roster.length) return;
  const findPeople = makeMatcher(roster);
  const unread = items.filter((item) => !state.readings[item.id]).slice(0, READ_PER_RUN);
  const readings = await mapLimit(unread, READ_CONCURRENCY, (item) => readArticle(item, findPeople, now));
  unread.forEach((item, i) => { state.readings[item.id] = readings[i]; });
}

function forgetOld(state: State, now: number): void {
  for (const [id, reading] of Object.entries(state.readings)) {
    if (now - reading.at > 2 * FOUND_DAYS * 86_400_000) delete state.readings[id];
  }
  state.shared = state.shared.filter((entry) => now - entry.sharedAt < SHARED_DAYS * 86_400_000);
}

/** One story per link, newest first, none older than FOUND_DAYS. */
function keepFound(stories: ClubStory[], now: number): ClubStory[] {
  const seen = new Set<string>();
  return stories
    .filter((story) => now - Date.parse(story.publishedAt) < FOUND_DAYS * 86_400_000)
    .filter((story) => {
      if (seen.has(story.url)) return false;
      seen.add(story.url);
      return true;
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
    .slice(0, MAX_STORIES);
}

async function run(results: SourceResult[], now: number): Promise<void> {
  await load();
  const state = runtime.state;
  const search = (await searchClub(state, now)).filter((item) => recent(item, now));
  for (const item of search) state.readings[item.id] ??= { at: now, people: [], club: true, imageUrl: null, description: null };
  const items = newsItems(results, now);
  await readNew(items, state, now);
  const matched = [...items, ...search]
    .filter((item) => (state.readings[item.id]?.people.length ?? 0) > 0 || state.readings[item.id]?.club)
    .map((item) => storyFrom(item, state.readings[item.id]));
  // A story stays for FOUND_DAYS even after its article has aged out of the feed's own window.
  state.found = keepFound([...matched, ...state.found], now);
  forgetOld(state, now);
  state.updatedAt = new Date(now).toISOString();
  await save();
}

/** Looks for the club in the news the feed has just fetched. Overlapping calls share one run. Never rejects. */
export function refreshClubNews(results: SourceResult[], now = Date.now()): Promise<void> {
  return (runtime.running ??= (async () => {
    try {
      await run(results, now);
    } catch (error) {
      console.warn("[club-news] run failed:", error instanceof Error ? error.message : error);
    } finally {
      runtime.running = null;
    }
  })());
}

/** What the person who shared a link wrote after it, as a short plain name: "Nicholas Chua". */
function aboutText(raw: string | null): string | null {
  const text = raw ? tidy(raw.replace(/[^\p{L}\p{N} &'’.,-]/gu, " ")) : "";
  return text ? clip(text, ABOUT_MAX) : null;
}

/** Puts a link shared in Slack into the spotlight for SHARED_DAYS. False when nothing could be read from the link. */
export async function shareStory(url: string, about: string | null, userId: string | null, now = Date.now()): Promise<boolean> {
  const preview = await previewLink(url);
  if (!preview) return false;
  await load();
  const person = aboutText(about);
  const story: ClubStory = {
    id: makeId("slack", url),
    title: preview.title,
    summary: preview.summary,
    source: preview.source,
    url,
    imageUrl: preview.imageUrl,
    publishedAt: preview.publishedAt ?? new Date(now).toISOString(),
    people: person ? [person] : [],
    via: "slack",
    sharedBy: userId ? await resolveUserName(userId) : null,
  };
  const state = runtime.state;
  state.shared = [{ story, sharedAt: now }, ...state.shared.filter((entry) => entry.story.id !== story.id)];
  await save();
  return true;
}

/** Takes every shared story out of the spotlight ("@bot spotlight off"). */
export async function clearShared(): Promise<void> {
  await load();
  runtime.state.shared = [];
  await save();
}

export async function getClubNews(now = Date.now()): Promise<ClubNewsResponse> {
  try {
    await load();
  } catch {
    // Start empty.
  }
  const state = runtime.state;
  const sharedNow = state.shared.filter((entry) => now - entry.sharedAt < SHARED_DAYS * 86_400_000).map((entry) => entry.story);
  const found = state.found.filter((story) => now - Date.parse(story.publishedAt) < FOUND_DAYS * 86_400_000);
  return { stories: [...sharedNow, ...found].slice(0, MAX_STORIES), updatedAt: state.updatedAt };
}
