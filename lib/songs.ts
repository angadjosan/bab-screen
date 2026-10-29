// Song requests: reads new messages from a Slack channel and adds every Spotify track link in
// them to the playback queue (default) and/or a playlist of the connected Spotify account.
// Messages without a track link are ignored. A message that mentions the bot with the word "jam"
// is not a song request: it puts the Jam QR on the screen for a minute (lib/jam.ts). One with "focus",
// "unfocus", "pause", "play", "dim" or a volume is a command (lib/commands.ts).
//
// syncSongs() is the single entry point. It is idempotent (a persisted cursor means a message is
// only ever handled once, across restarts too), safe to call concurrently, and never throws.
//
// Two things call it: the poll (ensureSongsLoop) and, while the Jarvis agent's Slack listener is up,
// a nudge for each new message in the channel (nudgeSongs, from /api/slack/nudge). Both go through
// the same lock and cursor in this process, which stays the only writer of .data/songs.json, so a
// message is still queued once. While the listener is up the poll only runs every 5 minutes, as a
// safety net, unless a request is waiting (for playback to start, say).

import { looksLikeCommand, parseCommand, runCommand } from "./commands";
import { getJamStatus, looksLikeJamTrigger, parseJamTrigger, recordJamTrigger, type JamStatus } from "./jam";
import { slackListenerLive } from "./slack-live";
import { resolveUserName } from "./slack-users";
import { readJson, writeJson } from "./songs-store";
import {
  PLAYLIST_SCOPES,
  QUEUE_SCOPES,
  SpotifyError,
  addToPlaylist,
  addToQueue,
  createPlaylist,
  expandShortLink,
  findTrackLinks,
  getTrack,
  listDevices,
  parsePlaylistId,
  playlistTrackIds,
  redirectUri,
  spotifyConnection,
  type SpotifyConnection,
  type Track,
  type TrackLink,
} from "./spotify";

const STATE_FILE = "songs.json";
const SLACK_TIMEOUT_MS = 10_000;
/** How many pending requests one run works on. */
const MAX_PER_RUN = 5;
const MAX_TRACKS_PER_MESSAGE = 5;
const MAX_PENDING = 50;
// Long enough that a request is still in the log when its track finally plays behind a long queue
// (lib/song-credit.ts reads it for the "Queued by" line).
const MAX_LOG = 200;
const MIN_RUN_INTERVAL_MS = 5_000;
const SLACK_ERROR_BACKOFF_MS = 60_000;
const DEFAULT_MAX_AGE_MINUTES = 30;
const DEFAULT_POLL_SECONDS = 5;
/** A nudged run that does not see its message yet (Slack's history lags the event) looks again. */
const NUDGE_ATTEMPTS = 3;
const NUDGE_RETRY_MS = 3_000;
const PLAYLIST_RESEED_MS = 6 * 60 * 60_000;
const PLAYLIST_SEED_RETRY_MS = 10 * 60_000;
const MAX_KNOWN_TRACKS = 5_000;
const AUTO_PLAYLIST_NAME = "B@B Song Requests";

export type SongsMode = "playlist" | "queue" | "both";

type SlackMessage = {
  ts?: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
};

type TrackSummary = { id: string; name: string; artists: string[]; url: string };

type PendingRequest = {
  /** Slack ts, plus "#n" for the 2nd, 3rd... track of a message with several links. */
  id: string;
  ts: string;
  user: string | null;
  userName: string | null;
  /** Readable text for the status page. */
  text: string;
  postedAt: string;
  /** From the link itself; for a short link, filled in once it has been expanded. */
  trackId?: string;
  shortLink?: string;
  /** Title and artist, once Spotify has been asked. */
  track?: Track;
  /** Set once the playlist step is finished, so a later queue retry can never add it twice. */
  playlist?: "added" | "duplicate";
  /** Written to disk before a Spotify write, cleared after: detects a crash in between. */
  inFlight?: "playlist" | "queue";
  attempts: number;
  /** Epoch ms before which this request is not retried. */
  nextAttemptAt: number;
  /** Why it is still pending, e.g. "no_active_device". */
  waitingFor: string | null;
  detail: string | null;
};

export type SongResult = {
  id: string;
  /** Who asked. */
  user: string | null;
  userName: string | null;
  text: string;
  postedAt: string;
  finishedAt: string;
  /** added: in the playlist. queued: in the play queue. duplicate: already in the playlist. */
  status: "added" | "queued" | "duplicate" | "skipped" | "failed" | "expired";
  reason: string | null;
  /** One-line human summary of what happened. */
  outcome: string;
  track: TrackSummary | null;
  playlist: "added" | "duplicate" | null;
  /** "queued", or the reason it was not queued. Null when queueing was not attempted. */
  queue: string | null;
  repliedInSlack: boolean;
};

type PlaylistState = {
  id: string;
  source: "env" | "created";
  name: string | null;
  /** Track IDs known to be in the playlist; avoids re-reading it for every request. */
  trackIds: string[];
  seededAt: string | null;
};

type SongsState = {
  version: 1;
  channel: string | null;
  /** Slack ts of the newest message already seen. Null until the first successful read. */
  cursor: string | null;
  pending: PendingRequest[];
  /** Finished requests, newest first. */
  log: SongResult[];
  playlist: PlaylistState | null;
  /** When Spotify last refused a queue add because the account is not Premium; cleared by a successful add. */
  premiumRequiredAt: string | null;
  /** How many messages were skipped for having no track link. */
  ignored: number;
  lastPollAt: string | null;
  lastSyncAt: string | null;
};

export type SongsStatus = {
  status: "ok" | "unconfigured" | "needs_attention" | "error";
  /** What, if anything, a human needs to do. */
  message: string;
  slack: {
    configured: boolean;
    channel: string | null;
    /** Null until the first read attempt. */
    canRead: boolean | null;
    error: string | null;
    help: string | null;
    lastPollAt: string | null;
    /** Messages from people that had no Spotify track link, counted since the state file was created. */
    ignoredMessages: number;
    replyInThread: boolean;
  };
  spotify: {
    configured: boolean;
    connected: boolean;
    mode: SongsMode;
    loginUrl: string;
    redirectUri: string;
    playlist: { id: string; url: string; name: string | null; source: "env" | "created"; knownTracks: number } | null;
    missingScopes: string[];
    problem: string | null;
    help: string | null;
  };
  /** slackListener: the Jarvis listener is up, so runs follow new messages and the poll is a 5-minute safety net. */
  loop: { running: boolean; everySeconds: number; slackListener: boolean };
  /** The Jam invite link the QR would show, where it came from, and whether the QR is up. */
  jam: JamStatus;
  lastSyncAt: string | null;
  pending: Array<{
    id: string;
    user: string | null;
    userName: string | null;
    text: string;
    postedAt: string;
    track: TrackSummary | null;
    waitingFor: string | null;
    detail: string | null;
    attempts: number;
  }>;
  recent: SongResult[];
};

// Kept on globalThis so every copy of this module (route bundles, dev-mode reloads, the
// instrumentation hook) shares one lock, one timer and one view of Slack's health.
type Runtime = {
  running?: Promise<SongsStatus>;
  lastRunAt: number;
  /** Requests waiting after the last run; while any wait, the poll keeps its full pace. */
  pending: number;
  timer?: ReturnType<typeof setInterval>;
  timerSeconds?: number;
  tick?: () => void;
  slackRetryAt: number;
  slackCanRead: boolean | null;
  slackError: string | null;
  spotifyProblem: string | null;
  spotifyHelp: string | null;
  seedRetryAt: number;
  premiumLogged?: boolean;
  /** The bot's own Slack user ID, from auth.test, and the token it was asked with. */
  botUser?: { token: string; id: string };
};
const globalStore = globalThis as typeof globalThis & { __babSongs?: Runtime };
const runtime: Runtime = (globalStore.__babSongs ??= {
  lastRunAt: 0,
  pending: 0,
  slackRetryAt: 0,
  slackCanRead: null,
  slackError: null,
  spotifyProblem: null,
  spotifyHelp: null,
  seedRetryAt: 0,
});

// --- Configuration ---------------------------------------------------------------------------

export function songsMode(): SongsMode {
  const value = process.env.SPOTIFY_SONGS_MODE?.trim().toLowerCase();
  return value === "playlist" || value === "both" ? value : "queue";
}

function songsChannel(): string | null {
  return process.env.SLACK_SONGS_CHANNEL_ID?.trim() || null;
}

function replyEnabled(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.SLACK_SONGS_REPLY?.trim() ?? "");
}

function maxAgeMs(): number {
  const minutes = Number(process.env.SONGS_MAX_AGE_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_MAX_AGE_MINUTES) * 60_000;
}

function pollSeconds(): number {
  const raw = process.env.SONGS_POLL_SECONDS?.trim();
  if (!raw) return DEFAULT_POLL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0; // 0 / "off" disables the timer
  return Math.max(seconds, 5);
}

function requiredScopes(mode: SongsMode): string[] {
  if (mode === "playlist") return PLAYLIST_SCOPES;
  if (mode === "queue") return QUEUE_SCOPES;
  return [...PLAYLIST_SCOPES, ...QUEUE_SCOPES];
}

function missingScopes(connection: SpotifyConnection, mode: SongsMode): string[] {
  if (!connection.connected) return [];
  return requiredScopes(mode).filter((scope) => !connection.scopes.includes(scope));
}

// --- State -----------------------------------------------------------------------------------

function emptyState(channel: string | null): SongsState {
  return {
    version: 1,
    channel,
    cursor: null,
    pending: [],
    log: [],
    playlist: null,
    premiumRequiredAt: null,
    ignored: 0,
    lastPollAt: null,
    lastSyncAt: null,
  };
}

async function loadState(channel: string | null): Promise<SongsState> {
  const stored = await readJson<Partial<SongsState>>(STATE_FILE);
  if (!stored || stored.version !== 1) return emptyState(channel);
  const state: SongsState = {
    ...emptyState(channel),
    ...stored,
    // Anything without a track reference cannot be acted on.
    pending: (Array.isArray(stored.pending) ? stored.pending : []).filter(
      (request) => request.track || request.trackId || request.shortLink,
    ),
    log: Array.isArray(stored.log) ? stored.log : [],
  };
  // A different channel has a different timeline: start again from "now" rather than replaying it.
  if (channel && state.channel !== channel) {
    state.channel = channel;
    state.cursor = null;
    state.pending = [];
  }
  return state;
}

async function saveState(state: SongsState): Promise<void> {
  await writeJson(STATE_FILE, state, 0o600);
}

// --- Slack -----------------------------------------------------------------------------------

class SlackError extends Error {
  readonly code: string;
  readonly needed: string | null;
  readonly retryAfterMs: number | null;

  constructor(code: string, needed: string | null = null, retryAfterMs: number | null = null) {
    super(`Slack API error: ${code}`);
    this.code = code;
    this.needed = needed;
    this.retryAfterMs = retryAfterMs;
  }
}

async function slackCall<T>(method: string, params: Record<string, unknown>, post = false): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError("token_missing");

  const url = new URL(`https://slack.com/api/${method}`);
  if (!post) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));

  const response = await sendSlackRequest(url, token, params, post);
  if (response.status === 429) throw new SlackError("rate_limited", null, retryAfterMs(response));
  if (!response.ok) throw new SlackError(`http_${response.status}`);

  const payload = (await response.json()) as T & { ok: boolean; error?: string; needed?: string };
  if (!payload.ok) throw new SlackError(payload.error ?? "unknown", payload.needed ?? null);
  return payload;
}

async function sendSlackRequest(url: URL, token: string, params: Record<string, unknown>, post: boolean): Promise<Response> {
  try {
    return await fetch(url, slackRequestInit(token, params, post));
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SlackError(timedOut ? "timeout" : "network_error");
  }
}

function slackRequestInit(token: string, params: Record<string, unknown>, post: boolean): RequestInit {
  return {
    method: post ? "POST" : "GET",
    headers: post
      ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }
      : { Authorization: `Bearer ${token}` },
    body: post ? JSON.stringify(params) : undefined,
    cache: "no-store",
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  };
}

/** Slack's Retry-After in milliseconds, or null when it did not give a usable one. */
function retryAfterMs(response: Response): number | null {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

function slackHelp(code: string | null, channel: string | null): string | null {
  if (!code) return null;
  const where = channel ?? "the songs channel";
  if (code === "not_in_channel") {
    return `The bot is not a member of ${where}. In that channel, type /invite @<bot name> (or open the channel's Integrations tab and add the app).`;
  }
  if (code === "channel_not_found") {
    return `Slack can't see ${where} with this token: check the ID, and if the channel is private, invite the bot to it (/invite @<bot name>).`;
  }
  if (code.startsWith("missing_scope")) {
    return "The Slack app is missing a scope (channels:history for public channels, groups:history for private ones). Add it under OAuth & Permissions and reinstall the app.";
  }
  if (code === "token_missing" || code === "invalid_auth" || code === "not_authed" || code === "token_revoked") {
    return "Set a valid SLACK_BOT_TOKEN in .env.local.";
  }
  return "Temporary Slack problem; it is retried automatically.";
}

function compareTs(a: string, b: string): number {
  const [aSeconds, aMicros = "0"] = a.split(".");
  const [bSeconds, bMicros = "0"] = b.split(".");
  return Number(aSeconds) - Number(bSeconds) || Number(aMicros.padEnd(6, "0")) - Number(bMicros.padEnd(6, "0"));
}

function tsToIso(ts: string): string {
  const millis = Number(ts) * 1000;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : new Date().toISOString();
}

function displayText(raw: string): string {
  const text = raw
    .replace(/<(https?:\/\/[^<>|]+)(?:\|[^<>]*)?>/g, "$1")
    .replace(/<@[^<>]+>/g, "@someone")
    .replace(/<[#!][^<>|]*\|([^<>]*)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 240 ? `${text.slice(0, 237)}...` : text;
}

/** A message that a person typed into the channel itself (not a bot, a join notice or a thread reply). */
function isCandidate(message: SlackMessage): message is SlackMessage & { ts: string; user: string } {
  if (!message.ts || !message.user || message.bot_id || message.subtype) return false;
  if (message.thread_ts && message.thread_ts !== message.ts) return false;
  return Boolean(message.text?.trim());
}

/**
 * The bot's own Slack user ID, which is what an @-mention of it looks like in message text. Asked
 * once per process (auth.test needs no scope). Throws on a passing failure so the caller can come
 * back to the message; returns null when Slack will not say, and the message is then handled as
 * any other.
 */
async function botUserId(): Promise<string | null> {
  const token = process.env.SLACK_BOT_TOKEN ?? "";
  if (runtime.botUser?.token === token) return runtime.botUser.id;
  try {
    const payload = await slackCall<{ user_id?: string }>("auth.test", {});
    if (!payload.user_id) return null;
    runtime.botUser = { token, id: payload.user_id };
    return payload.user_id;
  } catch (error) {
    const code = error instanceof SlackError ? error.code : "unknown";
    if (code === "timeout" || code === "network_error" || code === "rate_limited" || code.startsWith("http_5")) throw error;
    return null;
  }
}

/**
 * Turns track links in messages newer than the cursor into pending requests, and acts on requests
 * for the Jam QR. Returns false when Slack could not be read.
 */
async function pollSlack(state: SongsState, channel: string): Promise<boolean> {
  if (Date.now() < runtime.slackRetryAt) return false;
  try {
    if (state.cursor === null) await startAtNewestMessage(state, channel);
    else await readNewMessages(state, channel);
    state.lastPollAt = new Date().toISOString();
    runtime.slackCanRead = true;
    runtime.slackError = null;
    return true;
  } catch (error) {
    recordSlackFailure(error);
    return false;
  }
}

/** First ever read: remember where the channel is now and do not touch the backlog. */
async function startAtNewestMessage(state: SongsState, channel: string): Promise<void> {
  const payload = await slackCall<{ messages?: SlackMessage[] }>("conversations.history", { channel, limit: "1" });
  state.cursor = payload.messages?.[0]?.ts ?? "0";
}

async function readNewMessages(state: SongsState, channel: string): Promise<void> {
  const payload = await slackCall<{ messages?: SlackMessage[] }>("conversations.history", {
    channel,
    oldest: state.cursor as string,
    inclusive: "false",
    limit: "100",
  });
  // Newest first from Slack; handle oldest first so requests are added in the order asked.
  const fresh = (payload.messages ?? [])
    .filter((message): message is SlackMessage & { ts: string } => Boolean(message.ts) && compareTs(message.ts as string, state.cursor as string) > 0)
    .sort((a, b) => compareTs(a.ts, b.ts));

  for (const message of fresh) await handleMessage(state, message);
}

function isJamRequest(message: SlackMessage): boolean {
  return isCandidate(message) && looksLikeJamTrigger(message.text);
}

/** A message with a track link is a song request even if it says "play". */
function isCommandRequest(message: SlackMessage): boolean {
  return isCandidate(message) && looksLikeCommand(message.text) && findTrackLinks(message.text ?? "").length === 0;
}

async function handleMessage(state: SongsState, message: SlackMessage & { ts: string }): Promise<void> {
  // Asked before the cursor moves: if Slack cannot be reached, the next poll starts at this message again.
  const jam = isJamRequest(message) ? parseJamTrigger(message.text, await botUserId()) : null;
  const command = !jam && isCommandRequest(message) ? parseCommand(message.text, await botUserId()) : null;
  state.cursor = message.ts;
  if (!isCandidate(message)) return;
  if (command) {
    const reply = await runCommand(command, message.user);
    if (reply) await replyEphemeral(message.user, reply.text, reply.blocks);
    return;
  }
  if (jam) {
    // Never a song request as well: a Jam invite can be a spotify.link short link, which findTrackLinks would pick up.
    await handleJamRequest(message, jam.link);
    return;
  }
  if (isAlreadyHandled(state, message.ts)) return;
  await addTrackRequests(state, message);
}

async function handleJamRequest(message: SlackMessage & { ts: string; user: string }, link: string | null): Promise<void> {
  const result = await recordJamTrigger({ link, postedAtMs: Number(message.ts) * 1000, user: message.user });
  if (result.shown && result.link) {
    await replyEphemeral(message.user, `Join the Spotify Jam: <${result.link}|Open Jam invite>\nThe QR is also on the screen for one minute.`);
  } else if (result.error) {
    await replyEphemeral(message.user, `Could not show the Jam: ${slackText(result.error)}`);
  }
}

const slackText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function isAlreadyHandled(state: SongsState, ts: string): boolean {
  return state.pending.some((request) => request.ts === ts) || state.log.some((result) => result.id.split("#")[0] === ts);
}

async function addTrackRequests(state: SongsState, message: SlackMessage & { ts: string; user: string }): Promise<void> {
  const links = findTrackLinks(message.text ?? "").slice(0, MAX_TRACKS_PER_MESSAGE);
  if (links.length === 0) {
    state.ignored += 1;
    return;
  }
  const tooOld = Date.now() - Number(message.ts) * 1000 > maxAgeMs();
  const userName = tooOld ? null : await resolveUserName(message.user);
  links.forEach((link, position) => admitRequest(state, pendingRequest(message, link, position, userName), tooOld));
}

function pendingRequest(
  message: SlackMessage & { ts: string; user: string },
  link: TrackLink,
  position: number,
  userName: string | null,
): PendingRequest {
  return {
    id: position === 0 ? message.ts : `${message.ts}#${position + 1}`,
    ts: message.ts,
    user: message.user,
    userName,
    text: displayText(message.text ?? ""),
    postedAt: tsToIso(message.ts),
    ...link,
    attempts: 0,
    nextAttemptAt: 0,
    waitingFor: null,
    detail: null,
  };
}

function admitRequest(state: SongsState, request: PendingRequest, tooOld: boolean): void {
  if (tooOld) {
    // Posted while the server was off, long enough ago that playing it now would be a surprise.
    finish(state, request, { status: "expired", reason: "too_old", outcome: "Posted too long ago to act on." });
  } else if (state.pending.length >= MAX_PENDING) {
    finish(state, request, { status: "failed", reason: "too_many_pending", outcome: "Too many requests are waiting." });
  } else {
    state.pending.push(request);
  }
}

function recordSlackFailure(error: unknown): void {
  const slackError = error instanceof SlackError ? error : new SlackError("unknown");
  runtime.slackCanRead = false;
  runtime.slackError = slackError.needed ? `${slackError.code} (needs ${slackError.needed})` : slackError.code;
  runtime.slackRetryAt = Date.now() + Math.max(SLACK_ERROR_BACKOFF_MS, slackError.retryAfterMs ?? 0);
}

/** Jam results and command answers are private to the requester and do not depend on song-request thread replies. */
async function replyEphemeral(user: string, text: string, blocks?: unknown[]): Promise<boolean> {
  const channel = songsChannel();
  if (!channel) return false;
  try {
    await slackCall("chat.postEphemeral", { channel, user, text, ...(blocks ? { blocks } : {}) }, true);
    return true;
  } catch (error) {
    console.error("Private reply failed:", error instanceof SlackError ? error.code : "unknown");
    return false;
  }
}

async function replyInThread(request: PendingRequest, text: string): Promise<boolean> {
  const channel = songsChannel();
  if (!replyEnabled() || !channel) return false;
  try {
    await slackCall("chat.postMessage", { channel, thread_ts: request.ts, text, unfurl_links: "false" }, true);
    return true;
  } catch {
    return false;
  }
}

// --- Outcomes --------------------------------------------------------------------------------

function summarize(track: Track | undefined): TrackSummary | null {
  if (!track) return null;
  return { id: track.id, name: track.name, artists: track.artists, url: `https://open.spotify.com/track/${track.id}` };
}

function trackLabel(track: Track): string {
  return track.artists.length > 0 ? `${track.name} — ${track.artists.join(", ")}` : track.name;
}

/** Stand-in used when Spotify could not be asked for the title; the add itself only needs the ID. */
function untitled(trackId: string): Track {
  return { id: trackId, name: `open.spotify.com/track/${trackId}`, artists: [] };
}

type Outcome = Pick<SongResult, "status" | "reason" | "outcome"> & { queue?: string | null };

/** Moves a request from pending to the log. */
function finish(state: SongsState, request: PendingRequest, outcome: Outcome): SongResult {
  const result: SongResult = {
    id: request.id,
    user: request.user,
    userName: request.userName,
    text: request.text,
    postedAt: request.postedAt,
    finishedAt: new Date().toISOString(),
    status: outcome.status,
    reason: outcome.reason,
    outcome: outcome.outcome,
    track: summarize(request.track ?? (request.trackId ? untitled(request.trackId) : undefined)),
    playlist: request.playlist ?? null,
    queue: outcome.queue ?? null,
    repliedInSlack: false,
  };
  state.pending = state.pending.filter((pending) => pending.id !== request.id);
  state.log.unshift(result);
  state.log.length = Math.min(state.log.length, MAX_LOG);
  return result;
}

const REPLY_STATUSES = new Set<SongResult["status"]>(["added", "queued", "duplicate"]);

async function finishAndReply(state: SongsState, request: PendingRequest, outcome: Outcome): Promise<void> {
  const result = finish(state, request, outcome);
  // Only when replies are enabled, and only to say where the song went.
  if (REPLY_STATUSES.has(result.status)) {
    result.repliedInSlack = await replyInThread(request, result.outcome);
  }
}

function backoff(request: PendingRequest, reason: string, detail: string | null): void {
  request.attempts += 1;
  request.waitingFor = reason;
  request.detail = detail;
  request.nextAttemptAt = Date.now() + Math.min(15_000 * 2 ** (request.attempts - 1), 5 * 60_000);
}

/** Problems that affect every request, so the rest of the run is skipped once one is hit. */
const BLOCKING = new Set([
  "not_configured",
  "not_connected",
  "login_expired",
  "insufficient_scope",
  "rate_limited",
  "no_active_device",
  "playlist_invalid",
  "playlist_not_found",
  "playlist_forbidden",
]);

function spotifyHelp(code: string): string {
  const login = "open http://127.0.0.1:3000/api/spotify/login on this computer";
  switch (code) {
    case "not_configured":
      return "Create a Spotify developer app and set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local.";
    case "not_connected":
      return `Spotify is not connected yet: ${login}.`;
    case "login_expired":
      return `The stored Spotify login was rejected: ${login} to connect again.`;
    case "insufficient_scope":
      return `The stored Spotify login lacks permissions this mode needs: ${login} to grant them.`;
    case "premium_required":
      return "Spotify refused to add to the queue because the connected account is not Premium (PREMIUM_REQUIRED). Connect a Premium account, or set SPOTIFY_SONGS_MODE=playlist.";
    case "no_active_device":
      return "Nothing is playing on Spotify. Press play in the Spotify app on this computer; waiting requests are queued as soon as playback starts.";
    case "rate_limited":
      return "Spotify is rate limiting requests; they resume automatically.";
    case "playlist_invalid":
      return "SPOTIFY_SONGS_PLAYLIST_ID is not a playlist ID or open.spotify.com/playlist/... link. Fix it, or remove it to have a playlist created automatically.";
    case "playlist_not_found":
      return "Spotify can't find the configured playlist. Check SPOTIFY_SONGS_PLAYLIST_ID.";
    case "playlist_forbidden":
      return "The connected Spotify account may not edit that playlist. Use a playlist it owns (or is a collaborator on), or remove SPOTIFY_SONGS_PLAYLIST_ID to have one created.";
    default:
      return "Temporary Spotify problem; it is retried automatically.";
  }
}

function errorCode(error: unknown, fallback: string): { code: string; detail: string | null } {
  if (error instanceof SpotifyError) return { code: error.code, detail: error.detail };
  return { code: fallback, detail: error instanceof Error ? error.message : String(error) };
}

// --- Playlist --------------------------------------------------------------------------------

class PlaylistError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** The playlist requests go to: SPOTIFY_SONGS_PLAYLIST_ID if set, otherwise one created on first use. */
async function ensurePlaylist(state: SongsState): Promise<PlaylistState> {
  const configured = process.env.SPOTIFY_SONGS_PLAYLIST_ID?.trim();
  if (configured) {
    const id = parsePlaylistId(configured);
    if (!id) throw new PlaylistError("playlist_invalid");
    if (state.playlist?.id !== id) {
      state.playlist = { id, source: "env", name: null, trackIds: [], seededAt: null };
      runtime.seedRetryAt = 0;
    }
    state.playlist.source = "env";
    return state.playlist;
  }
  if (state.playlist?.source === "created") return state.playlist;

  const created = await createPlaylist(AUTO_PLAYLIST_NAME, "Songs requested in Slack, added by the B@B screen.");
  // A brand-new playlist is empty, so its contents are already fully known.
  state.playlist = { id: created.id, source: "created", name: created.name, trackIds: [], seededAt: new Date().toISOString() };
  await saveState(state);
  return state.playlist;
}

/** Refreshes the local copy of what is in the playlist, at most every few hours (or when forced). */
async function seedPlaylist(state: SongsState, playlist: PlaylistState, force = false): Promise<boolean> {
  const fresh = playlist.seededAt !== null && Date.now() - Date.parse(playlist.seededAt) < PLAYLIST_RESEED_MS;
  if (!force && (fresh || Date.now() < runtime.seedRetryAt)) return true;
  try {
    const current = await playlistTrackIds(playlist.id);
    // A complete read replaces the set (picks up manual removals); a capped one can only add to it.
    const merged = current.complete ? current.ids : [...new Set([...playlist.trackIds, ...current.ids])];
    playlist.trackIds = merged.slice(-MAX_KNOWN_TRACKS);
    playlist.seededAt = new Date().toISOString();
    await saveState(state);
    return true;
  } catch {
    // Not fatal: duplicates are then only detected among tracks this app added itself.
    runtime.seedRetryAt = Date.now() + PLAYLIST_SEED_RETRY_MS;
    return false;
  }
}

function playlistErrorCode(error: unknown): { code: string; detail: string | null } {
  if (error instanceof PlaylistError) return { code: error.code, detail: null };
  const { code, detail } = errorCode(error, "playlist_failed");
  if (code === "not_found") return { code: "playlist_not_found", detail };
  if (code === "forbidden") return { code: "playlist_forbidden", detail };
  return { code, detail };
}

// --- Delivery --------------------------------------------------------------------------------

type StepResult = { done: true } | { done: false; code: string; detail: string | null };

/** Playlist step. Leaves request.playlist set when finished; safe to call again after a failure. */
async function deliverToPlaylist(state: SongsState, request: PendingRequest, track: Track): Promise<StepResult> {
  if (request.playlist) return { done: true };
  try {
    const playlist = await ensurePlaylist(state);

    if (request.inFlight === "playlist") {
      // The server stopped between "about to add" and "added": look before adding again.
      if (!(await seedPlaylist(state, playlist, true))) {
        return { done: false, code: "playlist_check_failed", detail: "Could not confirm whether the track was already added." };
      }
      request.inFlight = undefined;
      if (playlist.trackIds.includes(track.id)) {
        request.playlist = "added";
        await saveState(state);
        return { done: true };
      }
    } else {
      await seedPlaylist(state, playlist);
    }

    if (playlist.trackIds.includes(track.id)) {
      request.playlist = "duplicate";
      await saveState(state);
      return { done: true };
    }

    request.inFlight = "playlist";
    await saveState(state);
    try {
      await addToPlaylist(playlist.id, track.id);
    } catch (error) {
      // Spotify answered with an error, so nothing was added: safe to try again later.
      if (error instanceof SpotifyError && error.code !== "timeout" && error.code !== "network_error") {
        request.inFlight = undefined;
      }
      throw error;
    }
    playlist.trackIds.push(track.id);
    if (playlist.trackIds.length > MAX_KNOWN_TRACKS) playlist.trackIds = playlist.trackIds.slice(-MAX_KNOWN_TRACKS);
    request.playlist = "added";
    request.inFlight = undefined;
    await saveState(state);
    return { done: true };
  } catch (error) {
    return { done: false, ...playlistErrorCode(error) };
  }
}

/** Queue step: one attempt. A dropped connection is reported as "unknown" and never retried. */
async function deliverToQueue(state: SongsState, request: PendingRequest, track: Track): Promise<StepResult> {
  if (request.inFlight === "queue") {
    request.inFlight = undefined;
    return { done: false, code: "interrupted", detail: "The server stopped while queueing; not retried so it can't play twice." };
  }
  request.inFlight = "queue";
  await saveState(state);
  try {
    await addToQueue(track.id);
    request.inFlight = undefined;
    state.premiumRequiredAt = null;
    runtime.premiumLogged = false;
    return { done: true };
  } catch (error) {
    const { code, detail } = errorCode(error, "queue_failed");
    if (code === "premium_required") {
      state.premiumRequiredAt = new Date().toISOString();
      if (!runtime.premiumLogged) {
        runtime.premiumLogged = true;
        console.error(`Song requests: ${spotifyHelp("premium_required")}`);
      }
    }
    // A timeout may or may not have reached Spotify: treat like an interruption (no retry).
    request.inFlight = undefined;
    return { done: false, code: code === "timeout" || code === "network_error" ? "interrupted" : code, detail };
  }
}

async function describeDevices(): Promise<string> {
  try {
    const devices = await listDevices();
    if (devices.length === 0) return "Spotify sees no devices: open the Spotify app on this computer and press play.";
    return `Nothing is playing. Devices Spotify can see: ${devices.map((device) => device.name).join(", ")}. Press play on one.`;
  } catch {
    return "Nothing is playing on Spotify.";
  }
}

type RunContext = { mode: SongsMode; blocker: { code: string; detail: string | null } | null };

function block(context: RunContext, request: PendingRequest, code: string, detail: string | null): void {
  context.blocker = { code, detail };
  request.waitingFor = code;
  request.detail = detail ?? spotifyHelp(code);
}

function blockOrBackoff(context: RunContext, request: PendingRequest, code: string, detail: string | null): void {
  if (BLOCKING.has(code)) block(context, request, code, detail);
  else backoff(request, code, detail);
}

async function deliver(state: SongsState, request: PendingRequest, track: Track, context: RunContext): Promise<void> {
  const label = trackLabel(track);

  if (context.mode !== "queue") {
    const step = await deliverToPlaylist(state, request, track);
    if (!step.done) {
      blockOrBackoff(context, request, step.code, step.detail);
      return;
    }
    if (context.mode === "playlist") {
      await finishAndReply(state, request, playlistOutcome(request, label));
      return;
    }
  }

  const queued = await deliverToQueue(state, request, track);

  if (context.mode === "both") {
    // The playlist step is already done, so the request is finished whatever the queue says.
    await finishAndReply(state, request, playlistAndQueueOutcome(request, label, queued));
    return;
  }
  await settleQueueStep(state, request, label, queued, context);
}

function playlistOutcome(request: PendingRequest, label: string): Outcome {
  return request.playlist === "duplicate"
    ? { status: "duplicate", reason: "already_in_playlist", outcome: `Already in the playlist: ${label}` }
    : { status: "added", reason: null, outcome: `Added to the playlist: ${label}` };
}

function playlistAndQueueOutcome(request: PendingRequest, label: string, queued: StepResult): Outcome {
  const inPlaylist = request.playlist === "duplicate" ? "Already in the playlist" : "Added to the playlist";
  return queued.done
    ? { status: "queued", reason: null, outcome: `${inPlaylist} and queued: ${label}`, queue: "queued" }
    : {
        status: request.playlist === "duplicate" ? "duplicate" : "added",
        reason: null,
        outcome: `${inPlaylist}: ${label} (not queued: ${queued.code.replace(/_/g, " ")})`,
        queue: queued.code,
      };
}

/** Queue failures that finish the request for good, or null when it may still go through later. */
function finalQueueFailure(code: string, label: string): Outcome | null {
  if (code === "interrupted") {
    return {
      status: "failed",
      reason: "interrupted",
      outcome: `Could not confirm that ${label} was queued; not retried.`,
      queue: "interrupted",
    };
  }
  if (code === "not_found" || code === "http_400") {
    return {
      status: "failed",
      reason: "unknown_track",
      outcome: "Spotify does not recognise that track link.",
      queue: "unknown_track",
    };
  }
  if (code === "premium_required") {
    // Retrying the same request cannot help. Later requests are still tried, one call each, so a
    // change of account or plan is noticed without any action here.
    return {
      status: "failed",
      reason: "premium_required",
      outcome: `Not queued: ${label}. Spotify only lets Premium accounts add to the queue.`,
      queue: "premium_required",
    };
  }
  return null;
}

/** Queue mode: finishes, blocks or backs off the request according to what the queue step said. */
async function settleQueueStep(
  state: SongsState,
  request: PendingRequest,
  label: string,
  queued: StepResult,
  context: RunContext,
): Promise<void> {
  if (queued.done) {
    await finishAndReply(state, request, { status: "queued", reason: null, outcome: `Queued: ${label}`, queue: "queued" });
    return;
  }
  const failure = finalQueueFailure(queued.code, label);
  if (failure) {
    await finishAndReply(state, request, failure);
    return;
  }
  if (BLOCKING.has(queued.code)) {
    block(context, request, queued.code, queued.code === "no_active_device" ? await describeDevices() : queued.detail);
    return;
  }
  backoff(request, queued.code, queued.detail);
}

/** What happened to a request this run: still to work on, left alone until later, or out of state.pending. */
type RequestStep = "continue" | "later" | "removed";

async function processPending(state: SongsState, context: RunContext): Promise<void> {
  let handled = 0;
  // Index loop: finishing a request removes it from state.pending while iterating.
  for (let index = 0; index < state.pending.length; index += 1) {
    const request = state.pending[index];

    if (Date.now() - Date.parse(request.postedAt) > maxAgeMs()) {
      await expireRequest(state, request);
      index -= 1;
      continue;
    }
    if (context.blocker) {
      waitForBlocker(request, context.blocker);
      continue;
    }
    if (Date.now() < request.nextAttemptAt) continue;
    if (handled >= MAX_PER_RUN) break;
    handled += 1;

    if (await attemptRequest(state, request, context)) index -= 1;
  }
}

async function expireRequest(state: SongsState, request: PendingRequest): Promise<void> {
  const why = request.waitingFor ?? "not_processed_in_time";
  await finishAndReply(state, request, {
    status: "expired",
    reason: why,
    outcome: `Gave up after waiting (${why.replace(/_/g, " ")}).`,
  });
}

function waitForBlocker(request: PendingRequest, blocker: NonNullable<RunContext["blocker"]>): void {
  request.waitingFor = blocker.code;
  request.detail = blocker.detail ?? spotifyHelp(blocker.code);
}

/** Works on one request that is due. Returns true when the request left state.pending. */
async function attemptRequest(state: SongsState, request: PendingRequest, context: RunContext): Promise<boolean> {
  const expanded = await expandRequestLink(state, request);
  if (expanded !== "continue") return expanded === "removed";
  const trackId = request.track?.id ?? request.trackId;
  if (!trackId) return false; // unreachable: loadState drops requests without a track reference

  const looked = await lookUpRequestTrack(state, request, trackId, context);
  if (looked !== "continue") return looked === "removed";

  const before = state.pending.length;
  await deliver(state, request, request.track ?? untitled(trackId), context);
  await saveState(state);
  return state.pending.length < before;
}

async function expandRequestLink(state: SongsState, request: PendingRequest): Promise<RequestStep> {
  if (request.trackId || !request.shortLink) return "continue";
  let expanded: string | null;
  try {
    expanded = await expandShortLink(request.shortLink);
  } catch (error) {
    const { code, detail } = errorCode(error, "short_link_failed");
    backoff(request, code, detail);
    await saveState(state);
    return "later";
  }
  if (!expanded) {
    await finishAndReply(state, request, {
      status: "skipped",
      reason: "not_a_track_link",
      outcome: "That short link does not lead to a Spotify track.",
    });
    await saveState(state);
    return "removed";
  }
  request.trackId = expanded;
  return "continue";
}

async function lookUpRequestTrack(
  state: SongsState,
  request: PendingRequest,
  trackId: string,
  context: RunContext,
): Promise<RequestStep> {
  if (request.track) return "continue";
  // Title and artist for the log and the Slack reply. A link to a track that does not exist
  // stops here; any other lookup failure must not hold up the add, which only needs the ID.
  try {
    const found = await getTrack(trackId);
    if (!found) {
      await finishAndReply(state, request, {
        status: "failed",
        reason: "unknown_track",
        outcome: "Spotify does not recognise that track link.",
      });
      await saveState(state);
      return "removed";
    }
    request.track = found;
  } catch (error) {
    const { code, detail } = errorCode(error, "lookup_failed");
    // Account-wide problems (not logged in, rate limited...) would fail the add in the same way.
    if (BLOCKING.has(code)) {
      block(context, request, code, detail);
      await saveState(state);
      return "later";
    }
  }
  return "continue";
}

// --- Orchestration ---------------------------------------------------------------------------

async function run(): Promise<void> {
  const channel = songsChannel();
  if (!process.env.SLACK_BOT_TOKEN || !channel) return;

  const state = await loadState(channel);
  await pollSlack(state, channel);
  await saveState(state);

  const mode = songsMode();
  const connection = await spotifyConnection();
  const context: RunContext = { mode, blocker: null };
  if (!connection.configured) context.blocker = { code: "not_configured", detail: null };
  else if (connection.loginExpired) context.blocker = { code: "login_expired", detail: null };
  else if (!connection.connected) context.blocker = { code: "not_connected", detail: null };
  else if (missingScopes(connection, mode).length > 0) {
    context.blocker = { code: "insufficient_scope", detail: `Missing: ${missingScopes(connection, mode).join(", ")}.` };
  }

  await processPending(state, context);

  runtime.spotifyProblem = context.blocker?.code ?? null;
  runtime.spotifyHelp = context.blocker
    ? [spotifyHelp(context.blocker.code), context.blocker.detail].filter(Boolean).join(" ")
    : null;
  state.lastSyncAt = new Date().toISOString();
  runtime.pending = state.pending.length;
  await saveState(state);
}

/** Current state without touching Slack or Spotify. Never throws. */
export async function getSongsStatus(): Promise<SongsStatus> {
  const channel = songsChannel();
  const slackConfigured = Boolean(process.env.SLACK_BOT_TOKEN && channel);
  const mode = songsMode();
  const everySeconds = pollSeconds();

  let state = emptyState(channel);
  let connection: SpotifyConnection = { configured: false, connected: false, loginExpired: false, connectedAt: null, scopes: [], rateLimitedUntil: null };
  try {
    state = await loadState(channel);
    connection = await spotifyConnection();
  } catch {
    // fall through with the empty defaults
  }

  const missing = missingScopes(connection, mode);
  const spotifyProblem = currentSpotifyProblem(connection, missing, mode, state);
  const spotifyHelpText = spotifyProblemHelp(spotifyProblem, missing);

  const slackError = slackConfigured ? runtime.slackError : null;

  const todo = songsTodo(slackConfigured, slackError, channel, spotifyHelpText);

  const unconfigured = !slackConfigured || !connection.configured;
  const playlist = mode === "queue" ? null : state.playlist;

  return {
    status: overallStatus(unconfigured, todo),
    message: todo.length > 0 ? todo.join(" ") : "Listening for Spotify track links.",
    slack: {
      configured: slackConfigured,
      channel,
      canRead: slackConfigured ? runtime.slackCanRead : null,
      error: slackError,
      help: slackHelp(slackError, channel),
      lastPollAt: state.lastPollAt,
      ignoredMessages: state.ignored,
      replyInThread: replyEnabled(),
    },
    spotify: {
      configured: connection.configured,
      connected: connection.connected,
      mode,
      loginUrl: new URL("/api/spotify/login", redirectUri()).toString(),
      redirectUri: redirectUri(),
      playlist: playlistStatus(playlist),
      missingScopes: missing,
      problem: spotifyProblem,
      help: spotifyHelpText,
    },
    loop: { running: Boolean(runtime.timer), everySeconds, slackListener: slackListenerLive() },
    jam: await getJamStatus(),
    lastSyncAt: state.lastSyncAt,
    pending: state.pending.map(pendingStatus),
    recent: state.log.slice(0, 20),
  };
}

function currentSpotifyProblem(
  connection: SpotifyConnection,
  missing: string[],
  mode: SongsMode,
  state: SongsState,
): string | null {
  if (!connection.configured) return "not_configured";
  if (connection.loginExpired) return "login_expired";
  if (!connection.connected) return "not_connected";
  if (missing.length > 0) return "insufficient_scope";
  return runtime.spotifyProblem ?? (mode !== "playlist" && state.premiumRequiredAt ? "premium_required" : null);
}

function spotifyProblemHelp(problem: string | null, missing: string[]): string | null {
  if (!problem) return null;
  if (problem === runtime.spotifyProblem && runtime.spotifyHelp) return runtime.spotifyHelp;
  return spotifyHelp(problem) + (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "");
}

/** What a person has to do, Slack first. */
function songsTodo(
  slackConfigured: boolean,
  slackError: string | null,
  channel: string | null,
  spotifyHelpText: string | null,
): string[] {
  const todo: string[] = [];
  if (!slackConfigured) todo.push("Set SLACK_BOT_TOKEN and SLACK_SONGS_CHANNEL_ID in .env.local.");
  else if (slackError) todo.push(slackHelp(slackError, channel) ?? slackError);
  if (spotifyHelpText) todo.push(spotifyHelpText);
  return todo;
}

function overallStatus(unconfigured: boolean, todo: string[]): SongsStatus["status"] {
  if (unconfigured) return "unconfigured";
  return todo.length > 0 ? "needs_attention" : "ok";
}

function playlistStatus(playlist: PlaylistState | null): SongsStatus["spotify"]["playlist"] {
  if (!playlist) return null;
  return {
    id: playlist.id,
    url: `https://open.spotify.com/playlist/${playlist.id}`,
    name: playlist.name,
    source: playlist.source,
    knownTracks: playlist.trackIds.length,
  };
}

function pendingStatus(request: PendingRequest): SongsStatus["pending"][number] {
  return {
    id: request.id,
    user: request.user,
    userName: request.userName,
    text: request.text,
    postedAt: request.postedAt,
    track: summarize(request.track ?? (request.trackId ? untitled(request.trackId) : undefined)),
    waitingFor: request.waitingFor,
    detail: request.detail,
    attempts: request.attempts,
  };
}

/**
 * Reads new Slack messages and acts on them, then returns the status. Concurrent calls share one
 * run; calls within a few seconds of the last run return the status without doing work unless
 * `force` is set. Never throws.
 */
export function syncSongs(options: { force?: boolean } = {}): Promise<SongsStatus> {
  if (runtime.running) return runtime.running;
  if (!options.force && Date.now() - runtime.lastRunAt < MIN_RUN_INTERVAL_MS) return getSongsStatus();

  runtime.running = (async () => {
    let failure: string | null = null;
    try {
      await run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      console.error("Song sync failed:", failure);
    }
    const status = await getSongsStatus();
    return failure ? { ...status, status: "error" as const, message: `Sync failed: ${failure}` } : status;
  })().finally(() => {
    runtime.lastRunAt = Date.now();
    runtime.running = undefined;
  });
  return runtime.running;
}

// Always point the timer at the newest copy of this module (dev-mode reloads re-run this line).
runtime.tick = () => {
  void syncSongs({ force: true });
};

/**
 * The Slack listener saw a new message in the songs channel (`ts`, when known): run now. If the
 * run did not get as far as that message (one was already running, or Slack's history did not
 * have it yet), run again a few seconds later, at most NUDGE_ATTEMPTS times. Never throws.
 */
export async function nudgeSongs(ts: string | null = null): Promise<void> {
  const channel = songsChannel();
  if (!process.env.SLACK_BOT_TOKEN || !channel) return;
  ensureSongsLoop();
  for (let attempt = 1; attempt <= NUDGE_ATTEMPTS; attempt += 1) {
    await syncSongs({ force: true });
    if (!ts) return;
    const { cursor } = await loadState(channel);
    if (cursor !== null && compareTs(cursor, ts) >= 0) return;
    if (attempt < NUDGE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, NUDGE_RETRY_MS));
  }
}

/**
 * Starts the background poll (every SONGS_POLL_SECONDS, default 5; 0 disables it). Safe to call
 * repeatedly: there is one timer per server process.
 */
export function ensureSongsLoop(): boolean {
  const seconds = pollSeconds();
  if (runtime.timer && runtime.timerSeconds !== seconds) {
    clearInterval(runtime.timer);
    runtime.timer = undefined;
  }
  if (seconds === 0) return false;
  if (!runtime.timer) {
    runtime.timer = setInterval(() => runtime.tick?.(), seconds * 1000);
    runtime.timerSeconds = seconds;
    runtime.timer.unref?.();
  }
  return true;
}
