// Jam QR: for one minute after someone mentions the Slack bot with the word "jam", the now-playing
// tile shows a QR code of the Spotify Jam's invite link.
//
// Spotify has no API for Jams, so nothing here starts, finds or checks one. The Jam is started by
// hand in the Spotify app and its invite link is given to the server: SPOTIFY_JAM_URL in
// .env.local, or "@bot jam <link>" in Slack, which is stored in .data/jam.json and wins over the
// env var. The Slack side (reading the channel, knowing the bot's user ID) is in lib/songs.ts.

import qrcode from "qrcode-generator";
import { readJson, writeJson } from "./songs-store";

const STATE_FILE = "jam.json";
/** How long the QR stays up, counted from the moment the server sees the message. */
export const JAM_SHOW_MS = 60_000;
/** A trigger posted longer ago than this (the server was off) no longer puts the QR up. */
export const JAM_STALE_MS = 2 * 60_000;
const MAX_LINK_LENGTH = 300;
/** Light modules around the code, which scanners need to find it. The standard asks for four. */
const QUIET_ZONE = 4;

const SHORT_LINK_HOSTS = new Set(["spotify.link", "spotify.app.link"]);
// open.spotify.com/socialsession/<token>, optionally behind a locale segment (/intl-de/).
const SESSION_PATH = /^\/(?:intl-[a-z-]+\/)?socialsession\/[A-Za-z0-9_-]+\/?$/;
const SHORT_PATH = /^\/[A-Za-z0-9_-]+\/?$/;
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

type JamState = {
  version: 1;
  /** The invite link last given in Slack. Null until someone gives one. */
  url: string | null;
  urlSetAt: string | null;
  /** Slack user ID of whoever gave it. */
  urlSetBy: string | null;
  /** Epoch ms until which the tile shows the QR. */
  showUntil: number | null;
};

/** What the now-playing tile needs while the QR is up. */
export type JamView = {
  /** Server time (epoch ms) at which the tile goes back to the song. The same for every poll of one showing. */
  until: number;
  /** Time left when this reply was made. The page counts down from this, so its own clock need not match the server's. */
  remainingMs: number;
  totalMs: number;
  /** The link in the QR. Null when no link is known: the tile then says how to set one. */
  url: string | null;
  qr: JamQr | null;
};

/** The code as one SVG path on a grid of `modules` x `modules` unit squares, quiet zone included. */
export type JamQr = { modules: number; path: string };

export type JamStatus = {
  link: string | null;
  /** slack: given with "@bot jam <link>". env: SPOTIFY_JAM_URL. */
  source: "slack" | "env" | null;
  setAt: string | null;
  /** Set while the QR is on screen. */
  showingUntil: string | null;
};

// --- Links -----------------------------------------------------------------------------------

/**
 * The link if it is a Spotify Jam invite link, otherwise null. Only https links to
 * open.spotify.com/socialsession/... and to Spotify's short-link hosts pass, so nothing else can
 * ever end up in the QR.
 */
export function jamLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/&amp;/g, "&");
  if (!raw || raw.length > MAX_LINK_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const ok =
    url.hostname === "open.spotify.com" ? SESSION_PATH.test(url.pathname) : SHORT_LINK_HOSTS.has(url.hostname) && SHORT_PATH.test(url.pathname);
  if (!ok) return null;
  url.hash = "";
  return url.toString();
}

/** The first Jam invite link in a Slack message text (Slack writes links as <url> or <url|label>). */
export function findJamLink(text: string): string | null {
  for (const match of (text ?? "").matchAll(/https:\/\/[^\s<>|]+/g)) {
    const link = jamLink(match[0]);
    if (link) return link;
  }
  return null;
}

// --- Trigger ---------------------------------------------------------------------------------

/** The message with mentions, links and other <...> tokens taken out: what the person typed as words. */
function words(text: string): string {
  return (text ?? "").replace(/<[^<>]*>/g, " ").replace(/https?:\/\/\S+/g, " ");
}

/** Cheap first look that needs no bot ID: someone is mentioned and the word "jam" is there. */
export function looksLikeJamTrigger(text: string | undefined): boolean {
  return typeof text === "string" && text.includes("<@") && /\bjam\b/i.test(words(text));
}

/**
 * Whether a message asks for the Jam QR: it mentions the bot (<@BOTID>) and has the word "jam"
 * (any case, as a whole word, not inside a link). Returns the invite link it carries, if any;
 * null when the message is not a trigger.
 */
export function parseJamTrigger(text: string | undefined, botUserId: string | null): { link: string | null } | null {
  if (typeof text !== "string" || !botUserId || !SLACK_USER_ID.test(botUserId)) return null;
  if (!new RegExp(`<@${botUserId}(?:\\|[^<>]*)?>`).test(text)) return null;
  if (!/\bjam\b/i.test(words(text))) return null;
  return { link: findJamLink(text) };
}

// --- State -----------------------------------------------------------------------------------

async function loadState(): Promise<JamState> {
  const stored = await readJson<Partial<JamState>>(STATE_FILE);
  const valid = stored && stored.version === 1;
  return {
    version: 1,
    // Checked again on the way out, so an edited file cannot put another site in the QR.
    url: valid ? jamLink(stored.url) : null,
    urlSetAt: valid && typeof stored.urlSetAt === "string" ? stored.urlSetAt : null,
    urlSetBy: valid && typeof stored.urlSetBy === "string" ? stored.urlSetBy : null,
    showUntil: valid && typeof stored.showUntil === "number" && Number.isFinite(stored.showUntil) ? stored.showUntil : null,
  };
}

/** The link to show: the one given in Slack, else SPOTIFY_JAM_URL. */
function currentLink(state: JamState): { url: string; source: "slack" | "env" } | null {
  if (state.url) return { url: state.url, source: "slack" };
  const fromEnv = jamLink(process.env.SPOTIFY_JAM_URL);
  return fromEnv ? { url: fromEnv, source: "env" } : null;
}

/**
 * Acts on a trigger message: stores the link it carries, and puts the QR up for a minute from now
 * unless the message is stale. Never throws.
 */
export async function recordJamTrigger(trigger: {
  link: string | null;
  /** When the message was posted (epoch ms). */
  postedAtMs: number;
  user: string | null;
}): Promise<{ stored: boolean; shown: boolean }> {
  try {
    const now = Date.now();
    const state = await loadState();
    const link = jamLink(trigger.link);
    const stored = Boolean(link) && link !== state.url;
    if (link && stored) {
      state.url = link;
      state.urlSetAt = new Date(now).toISOString();
      state.urlSetBy = trigger.user;
    }
    const shown = Number.isFinite(trigger.postedAtMs) && now - trigger.postedAtMs <= JAM_STALE_MS;
    if (shown) state.showUntil = now + JAM_SHOW_MS;
    if (stored || shown) await writeJson(STATE_FILE, state, 0o600);
    return { stored, shown };
  } catch (error) {
    console.error("Jam QR: could not record the request:", error instanceof Error ? error.message : String(error));
    return { stored: false, shown: false };
  }
}

// --- QR --------------------------------------------------------------------------------------

let lastQr: { url: string; qr: JamQr } | null = null;

/** Error correction M (15%): a low-density code with larger modules reads from further away than a denser, more redundant one. */
export function buildQr(url: string): JamQr {
  if (lastQr?.url === url) return lastQr.qr;
  const code = qrcode(0, "M");
  code.addData(url, "Byte");
  code.make();
  const count = code.getModuleCount();
  let path = "";
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (!code.isDark(row, col)) continue;
      let end = col;
      while (end + 1 < count && code.isDark(row, end + 1)) end += 1;
      // One rectangle per run of dark modules in a row.
      path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${end - col + 1}v1h-${end - col + 1}z`;
      col = end;
    }
  }
  const qr = { modules: count + 2 * QUIET_ZONE, path };
  lastQr = { url, qr };
  return qr;
}

// --- Reads -----------------------------------------------------------------------------------

/** What the tile should show right now, or null when the QR is not up. Reads one small local file. Never throws. */
export async function getJamView(): Promise<JamView | null> {
  try {
    const state = await loadState();
    const now = Date.now();
    const remainingMs = (state.showUntil ?? 0) - now;
    // The upper bound guards against a clock that was set back while the QR was up.
    if (remainingMs <= 0 || remainingMs > JAM_SHOW_MS) return null;
    const link = currentLink(state);
    return {
      until: state.showUntil as number,
      remainingMs,
      totalMs: JAM_SHOW_MS,
      url: link?.url ?? null,
      qr: link ? buildQr(link.url) : null,
    };
  } catch {
    return null;
  }
}

/** For the status JSON. Never throws. */
export async function getJamStatus(): Promise<JamStatus> {
  try {
    const state = await loadState();
    const link = currentLink(state);
    const showing = state.showUntil !== null && state.showUntil > Date.now() && state.showUntil - Date.now() <= JAM_SHOW_MS;
    return {
      link: link?.url ?? null,
      source: link?.source ?? null,
      setAt: link?.source === "slack" ? state.urlSetAt : null,
      showingUntil: showing ? new Date(state.showUntil as number).toISOString() : null,
    };
  } catch {
    return { link: null, source: null, setAt: null, showingUntil: null };
  }
}
