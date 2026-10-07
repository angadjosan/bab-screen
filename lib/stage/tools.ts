// What Worm can look up while it answers. Each tool returns compact JSON text for the model, never markup, and never
// throws: a failure comes back as {"error": ...} so the model can say what it could not find.

import { getClubNews } from "../club-news";
import { getEvents } from "../events";
import { getFeed } from "../feed";
import { fetchHyperliquidQuotes, makeAsset } from "../markets";
import { getNowPlaying } from "../now-playing";
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
  now_playing: {
    spec: tool("now_playing", "The song playing in the clubroom on Spotify.", {}, []),
    activity: () => "Checking what's playing",
    run: () => getNowPlaying(),
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
  if (!entry) return JSON.stringify({ error: `no tool called ${name}` });
  try {
    return JSON.stringify(await entry.run(parseArgs(rawArgs))).slice(0, RESULT_MAX_CHARS);
  } catch (error) {
    return JSON.stringify({ error: error instanceof Error ? error.message : "the lookup failed" });
  }
}
