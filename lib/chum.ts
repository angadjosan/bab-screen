// Chumming photos for the carousel: pictures posted in the club's "chumming" Slack channel
// (SLACK_CHUM_CHANNEL_ID), where members post photos of themselves hanging out with other members. Every
// photo of the last 2 years is in the pool (read once an hour); the carousel gets six of them at a time: the
// newest, and five drawn at random from the rest, drawn again every 10 minutes.
//
// Read-only, and separate from the spots in lib/slack.ts: its own channel, its own cache, its own
// status. It shares only the Slack request helper, the signed image proxy (/api/spot/image) and the
// name lookups, so a failure here never reaches /api/spot or /api/quotes.

import { SlackApiError, isImageFile, signedImagePath, slackGet, type SlackMessage } from "./slack";
import { describeSpot } from "./slack-users";

/** How many photos /api/chum returns (newest first): the newest photo and the rest drawn at random. */
export const MAX_CHUM_PHOTOS = 6;

export type ChumPhoto = {
  /** Message ts plus file id: unique per photo and stable across polls. */
  id: string;
  imageUrl: string;
  /** The message as plain text (mentions as @Name; emoji codes and links removed), or null. */
  text: string | null;
  /** Who posted the photo, or null if the name can't be resolved. */
  poster: string | null;
  /** The people the poster named: who they were chumming with. In order of appearance. */
  chums: string[];
  postedAt: string | null;
  permalink: string | null;
};

export type ChumResult = {
  status: "ok" | "empty" | "unconfigured" | "error";
  /**
   * The newest photo and a random draw from the last 2 years, newest first, at most MAX_CHUM_PHOTOS. Photos are counted one by one: a
   * message with two pictures gives two entries (in the order they were attached) with the same
   * text, poster and chums.
   */
  photos: ChumPhoto[];
  message?: string;
};

const OK_TTL_MS = 60_000;
const RETRY_TTL_MS = 20_000;
/** Only photos posted in the last 2 years are read and shown; counted back from now on every read. */
export const CHUM_MAX_AGE_DAYS = 730;
/** The whole window is read again this often, so a deleted photo leaves the screen within the hour. */
const POOL_REFRESH_MS = 60 * 60_000;
/** The random part of the six is drawn again this often. */
const DRAW_MS = 10 * 60_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
/** conversations.history is rate-limit tier 3 (about 50 a minute); this keeps a full read far below it. */
const PAGE_GAP_MS = 1_200;

type Match = { message: SlackMessage; ts: string; fileId: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Slack emoji codes (":fire:", ":wave::skin-tone-3:") and bare links say nothing on a TV. */
function tidyText(text: string | null): string | null {
  if (!text) return null;
  const tidy = text
    .replace(/(?<!\d):[a-z0-9_+'-]+:(?!\d)/gi, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return tidy || null;
}

/** A photo post: typed by a person at the top level of the channel. */
function isPost(message: SlackMessage): boolean {
  if (!message.ts || !message.user || message.bot_id) return false;
  // Join notices, Slackbot responses, deleted-message tombstones, replies also sent to the channel...
  if (message.subtype && message.subtype !== "file_share") return false;
  return !message.thread_ts || message.thread_ts === message.ts;
}

type Fetched = { value: ChumResult; ttlMs: number };

/** Every photo of the window, newest first. Throws if Slack cannot be read; stops early on a later failure. */
async function readPool(channel: string): Promise<Match[]> {
  const oldest = ((Date.now() - CHUM_MAX_AGE_DAYS * 24 * 60 * 60_000) / 1000).toFixed(6);
  const matches: Match[] = [];
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await sleep(PAGE_GAP_MS);
    let payload: { messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } };
    try {
      payload = await slackGet("conversations.history", { channel, oldest, limit: String(PAGE_SIZE), ...(cursor ? { cursor } : {}) });
    } catch (error) {
      if (page === 0) throw error;
      break;
    }
    for (const message of payload.messages ?? []) {
      if (!isPost(message)) continue;
      for (const file of message.files ?? []) {
        if (!file.id || !isImageFile(file) || (file.mode && file.mode !== "hosted")) continue;
        matches.push({ message, ts: message.ts as string, fileId: file.id });
      }
    }
    cursor = payload.response_metadata?.next_cursor ?? "";
    if (!payload.has_more || !cursor) break;
  }
  return matches;
}

let pool: { channel: string; readAt: number; matches: Match[] } | undefined;
let draw: { at: number; keys: string[] } | undefined;
const matchKey = (match: Match) => `${match.ts}-${match.fileId}`;

/**
 * The newest photo and MAX_CHUM_PHOTOS - 1 others at random, newest first. The same six are given until the
 * draw is DRAW_MS old or one of them leaves the pool; a new newest photo joins at once.
 */
function drawSix(matches: Match[]): Match[] {
  const byKey = new Map(matches.map((match) => [matchKey(match), match]));
  const newest = matches[0];
  const stale = !draw || Date.now() - draw.at > DRAW_MS || draw.keys.some((key) => !byKey.has(key));
  if (stale) {
    const rest = matches.slice(1);
    for (let i = rest.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    draw = { at: Date.now(), keys: rest.slice(0, MAX_CHUM_PHOTOS - 1).map(matchKey) };
  }
  const keys = draw?.keys ?? [];
  const chosen = keys.map((key) => byKey.get(key)).filter((match): match is Match => Boolean(match));
  if (newest && !keys.includes(matchKey(newest))) chosen.unshift(newest);
  return chosen.slice(0, MAX_CHUM_PHOTOS).sort((a, b) => Number(b.ts) - Number(a.ts));
}

async function fetchChum(): Promise<Fetched> {
  const channel = process.env.SLACK_CHUM_CHANNEL_ID;
  if (!process.env.SLACK_BOT_TOKEN || !channel) {
    return {
      ttlMs: RETRY_TTL_MS,
      value: {
        status: "unconfigured",
        photos: [],
        message: "Add SLACK_BOT_TOKEN and SLACK_CHUM_CHANNEL_ID to .env.local to show chumming photos.",
      },
    };
  }

  try {
    if (!pool || pool.channel !== channel || Date.now() - pool.readAt > POOL_REFRESH_MS) {
      try {
        pool = { channel, readAt: Date.now(), matches: await readPool(channel) };
      } catch (error) {
        // A failed re-read keeps showing the last pool; with none yet, the error is reported.
        if (!pool || pool.channel !== channel) throw error;
        pool.readAt = Date.now() - POOL_REFRESH_MS + RETRY_TTL_MS;
      }
    }
    const matches = drawSix(pool.matches);
    if (matches.length === 0) {
      return {
        ttlMs: OK_TTL_MS,
        value: { status: "empty", photos: [], message: "No photo was found in the last 2 years of the channel." },
      };
    }

    // One lookup per message, however many photos it has. describeSpot never throws.
    const messages = [...new Set(matches.map(({ message }) => message))];
    const described = await Promise.all(messages.map((message) => describeSpot(message)));
    const descriptions = new Map(messages.map((message, index) => [message, described[index]]));

    const photos: ChumPhoto[] = matches.map(({ message, ts, fileId }) => {
      const timestamp = Number(ts);
      const description = descriptions.get(message);
      return {
        id: `${ts}-${fileId}`,
        imageUrl: signedImagePath(fileId),
        text: tidyText(description?.text ?? null),
        poster: description?.spotter ?? null,
        chums: description?.spotted ?? [],
        postedAt: Number.isFinite(timestamp) ? new Date(timestamp * 1000).toISOString() : null,
        permalink: `https://app.slack.com/archives/${encodeURIComponent(channel)}/p${ts.replace(".", "")}`,
      };
    });

    // A poster without a name means the lookup failed (scope, rate limit, network): look again sooner.
    const namesMissing = photos.some((photo) => !photo.poster);
    return { ttlMs: namesMissing ? RETRY_TTL_MS : OK_TTL_MS, value: { status: "ok", photos } };
  } catch (error) {
    const code = error instanceof SlackApiError ? error.code : "network_error";
    return {
      ttlMs: RETRY_TTL_MS,
      value: {
        status: "error",
        photos: [],
        message: `Could not read the chumming channel (${code}). Check SLACK_CHUM_CHANNEL_ID, the scopes, and that the bot is in the channel.`,
      },
    };
  }
}

let cached: { value: ChumResult; expiresAt: number } | undefined;
let inFlight: Promise<ChumResult> | undefined;

/** Six chumming photos (see drawSix). Reads the channel at most once an hour per server process. Never throws. */
export async function getChumPhotos(): Promise<ChumResult> {
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  if (!inFlight) {
    inFlight = fetchChum()
      .then(({ value, ttlMs }) => {
        cached = { value, expiresAt: Date.now() + ttlMs };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
  }
  return inFlight;
}
