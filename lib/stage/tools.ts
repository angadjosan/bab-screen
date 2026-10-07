// What Worm can look up while it answers. Each tool returns compact JSON text for the model, never markup, and never
// throws: a failure comes back as {"error": ...} so the model can say what it could not find.

import { getClubNews } from "../club-news";
import { getEvents } from "../events";
import { getFeed } from "../feed";
import { fetchCandles } from "../candles";
import { recordJamTrigger } from "../jam";
import { fetchHyperliquidQuotes, makeAsset } from "../markets";
import { getNowPlaying } from "../now-playing";
import { addToQueue, getQueue, SpotifyError, searchTracks, type TrackCard } from "../spotify";
import { controlPlayback, musicVolume, setMusicVolume } from "./voice";
import type { ToolSpec } from "./fireworks";

const SLACK_SEARCH_URL = "https://slack.com/api/assistant.search.context";
const SLACK_TIMEOUT_MS = 10_000;
const RESULT_MAX_CHARS = 6_000;

type ToolArgs = Record<string, unknown>;
type Tool = { spec: ToolSpec; activity: (args: ToolArgs) => string; run: (args: ToolArgs) => Promise<unknown> };

const text = (value: unknown, max = 200) => (typeof value === "string" ? value.trim().slice(0, max) : "");

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}

type SlackSearchMessage = { author_name?: string; channel_name?: string; content?: string; message_ts?: string; permalink?: string };
type SlackSearchResponse = { ok: boolean; error?: string; needed?: string; results?: { messages?: SlackSearchMessage[] } };

/** Slack's search for apps. Needs the bot's search:read.public scope; without it the model is told what to ask for. */
async function searchSlack(args: ToolArgs): Promise<unknown> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return { error: "Slack is not connected" };
  const response = await fetch(SLACK_SEARCH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ query: text(args.query), limit: 12, content_types: ["messages"] }),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  const body = (await response.json()) as SlackSearchResponse;
  if (!body.ok) return { error: body.error === "missing_scope" ? `Slack search is not enabled for the bot yet (it needs the ${body.needed} scope)` : `Slack: ${body.error}` };
  return (body.results?.messages ?? []).map((message) => ({
    who: message.author_name,
    channel: message.channel_name,
    when: message.message_ts ? new Date(Number(message.message_ts) * 1000).toISOString() : null,
    text: text(message.content, 500),
  }));
}

function calendar(): unknown {
  const { events, timeZone } = getEvents();
  return { timeZone, events: events.map(({ title, start, end, allDay, location }) => ({ title, start, end, allDay, location })) };
}

async function marketPrice(args: ToolArgs): Promise<unknown> {
  const symbol = text(args.symbol, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const asset = makeAsset("hyperliquid", symbol, symbol, symbol);
  if (!asset) return { error: `not a market symbol: ${symbol}` };
  const { quotes } = await fetchHyperliquidQuotes([asset]);
  const quote = quotes.get(asset.market);
  return quote ? { symbol, price: quote.price, change24hPct: quote.changePct } : { error: `no Hyperliquid market for ${symbol}` };
}

async function news(): Promise<unknown> {
  const [feed, club] = await Promise.all([getFeed(), getClubNews()]);
  return {
    headlines: feed.items.slice(0, 15).map((item) => ({ source: item.source, title: item.title, publishedAt: item.publishedAt })),
    aboutTheClub: club.stories.map((story) => ({ source: story.source, title: story.title, people: story.people })),
  };
}

const LOGIN_HINT = "Spotify is not logged in on this Mac yet. Someone at the screen's computer needs to sign in once, at /api/spotify/login on this server.";

/** A Spotify Web API failure, said in words the model can pass on. */
function spotifyProblem(error: unknown): { error: string } {
  if (error instanceof SpotifyError && (error.code === "not_connected" || error.code === "insufficient_scope")) return { error: LOGIN_HINT };
  if (error instanceof SpotifyError && error.code === "no_active_device") return { error: "Spotify is not playing on any device right now" };
  return { error: error instanceof Error ? `Spotify: ${error.message}` : "Spotify could not be reached" };
}

const trackForModel = (track: TrackCard) => ({ name: track.name, artists: track.artists.join(", "), album: track.album, imageUrl: track.imageUrl });

async function spotifyQueue(): Promise<unknown> {
  try {
    const { playing, next } = await getQueue();
    return { nowPlaying: playing && trackForModel(playing), upNext: next.slice(0, 10).map(trackForModel) };
  } catch (error) {
    return spotifyProblem(error);
  }
}

async function queueSong(args: ToolArgs): Promise<unknown> {
  try {
    const [track] = await searchTracks(text(args.query, 120), 1);
    if (!track) return { error: `nothing on Spotify matches "${text(args.query, 120)}"` };
    await addToQueue(track.id);
    return { queued: trackForModel(track) };
  } catch (error) {
    return spotifyProblem(error);
  }
}

const PLAYBACK = ["play", "pause", "next", "previous"] as const;

async function playback(args: ToolArgs): Promise<unknown> {
  const action = PLAYBACK.find((name) => name === args.action);
  if (!action) return { error: `action must be one of ${PLAYBACK.join(", ")}` };
  return { done: action, playerState: await controlPlayback(action) };
}

async function volume(args: ToolArgs): Promise<unknown> {
  const current = await musicVolume();
  if (current === null) return { error: "Spotify is not running" };
  const level = typeof args.level === "number" ? args.level : current + (typeof args.change === "number" ? args.change : 0);
  await setMusicVolume(level);
  return { volume: Math.round(Math.min(100, Math.max(0, level))), was: current };
}

const HOUR_LABEL = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric" });

/** A token's last 24 hours as hourly closing prices, for drawing or comparing. */
async function priceHistory(args: ToolArgs): Promise<unknown> {
  const symbol = text(args.symbol, 12).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const asset = makeAsset("hyperliquid", symbol, symbol, symbol);
  if (!asset) return { error: `not a market symbol: ${symbol}` };
  const candles = await fetchCandles(asset, AbortSignal.timeout(SLACK_TIMEOUT_MS));
  if (candles.length < 2) return { error: `no price history for ${symbol}` };
  const hourly = candles.filter((_, i) => i % 2 === 1 || i === candles.length - 1);
  const first = candles[0].open;
  const last = candles[candles.length - 1].close;
  return {
    symbol,
    changePct: Number((((last - first) / first) * 100).toFixed(2)),
    hourly: hourly.map((candle) => ({ hour: HOUR_LABEL.format(candle.at), close: Number(candle.close.toPrecision(6)) })),
  };
}

async function showJam(): Promise<unknown> {
  const { shown } = await recordJamTrigger({ link: null, postedAtMs: Date.now(), user: null });
  return shown ? { shown: "The Spotify Jam QR code is on the screen for a minute, in the now-playing corner." } : { error: "No Jam link has been set yet; someone can set one in Slack with @bot jam <invite link>" };
}

const TOOLS: Record<string, Tool> = {
  search_slack: {
    spec: tool("search_slack", "Search the club's Slack messages. Use for anything about the club, its members, projects, task assignments, decisions or plans.", { query: { type: "string", description: "Search words" } }, ["query"]),
    activity: (args) => `Searching Slack for "${text(args.query, 60)}"`,
    run: searchSlack,
  },
  club_calendar: {
    spec: tool("club_calendar", "The club's calendar for the coming weeks: titles, times and places.", {}, []),
    activity: () => "Checking the calendar",
    run: async () => calendar(),
  },
  market_price: {
    spec: tool("market_price", "The live price and 24-hour change of a crypto token on Hyperliquid.", { symbol: { type: "string", description: "Ticker, e.g. ETH" } }, ["symbol"]),
    activity: (args) => `Checking the ${text(args.symbol, 12).toUpperCase()} price`,
    run: marketPrice,
  },
  price_history: {
    spec: tool("price_history", "A token's last 24 hours as hourly closing prices and its change over the day. Use it to draw or compare how tokens moved.", { symbol: { type: "string", description: "Ticker, e.g. ETH" } }, ["symbol"]),
    activity: (args) => `Getting ${text(args.symbol, 12).toUpperCase()}'s last day`,
    run: priceHistory,
  },
  show_jam: {
    spec: tool("show_jam", "Show the QR code for joining the clubroom's Spotify Jam, so people can add songs from their phones.", {}, []),
    activity: () => "Bringing up the Jam QR",
    run: showJam,
  },
  now_playing: {
    spec: tool("now_playing", "The song playing in the clubroom on Spotify, with its album cover (artworkUrl) and position.", {}, []),
    activity: () => "Checking what's playing",
    run: () => getNowPlaying(),
  },
  spotify_queue: {
    spec: tool("spotify_queue", "What is playing in the clubroom and the songs queued after it, with album covers (imageUrl) you can draw.", {}, []),
    activity: () => "Checking the queue",
    run: spotifyQueue,
  },
  queue_song: {
    spec: tool("queue_song", "Find a song on Spotify and add it to the end of the clubroom queue.", { query: { type: "string", description: "Song and artist, e.g. Bad Blood Taylor Swift" } }, ["query"]),
    activity: (args) => `Queueing "${text(args.query, 60)}"`,
    run: queueSong,
  },
  playback: {
    spec: tool("playback", "Play, pause, skip to the next song or go back to the previous one in the clubroom's Spotify.", { action: { type: "string", enum: [...PLAYBACK] } }, ["action"]),
    activity: (args) => `${text(args.action, 12) === "next" ? "Skipping" : "Changing"} the music`,
    run: playback,
  },
  music_volume: {
    spec: tool(
      "music_volume",
      "Set the music's volume, 0 to 100, or change it by an amount (e.g. +15 for louder, -15 for quieter). Returns the new and old volume.",
      { level: { type: "number", description: "New volume, 0 to 100" }, change: { type: "number", description: "Amount to change it by" } },
      [],
    ),
    activity: () => "Changing the volume",
    run: volume,
  },
  recent_news: {
    spec: tool("recent_news", "Today's tech, AI and crypto headlines on the screen, and recent stories about the club and its members.", {}, []),
    activity: () => "Reading today's news",
    run: news,
  },
};

export const toolSpecs = (): ToolSpec[] => Object.values(TOOLS).map((entry) => entry.spec);

function parseArgs(raw: string): ToolArgs {
  try {
    const parsed = JSON.parse(raw || "{}") as unknown;
    return parsed && typeof parsed === "object" ? (parsed as ToolArgs) : {};
  } catch {
    return {};
  }
}

/** What to show while a tool runs, e.g. "Searching Slack for "task assignments"". */
export function toolActivity(name: string, rawArgs: string): string {
  return TOOLS[name]?.activity(parseArgs(rawArgs)) ?? "Looking that up";
}

/** Runs one tool call and returns its result as text for the model. Never throws. */
export async function runTool(name: string, rawArgs: string): Promise<string> {
  const entry = TOOLS[name];
  if (!entry) {
    console.warn(`[stage] the model asked for a tool that does not exist: ${name}`);
    return JSON.stringify({ error: `no tool called ${name}; the tools are ${Object.keys(TOOLS).join(", ")}` });
  }
  try {
    return JSON.stringify(await entry.run(parseArgs(rawArgs))).slice(0, RESULT_MAX_CHARS);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "the lookup failed" });
  }
}
