// Song requests: reads new messages from a Slack channel, works out which Spotify track each one
// means, and adds it to a playlist and/or the playback queue of the connected Spotify account.
//
// syncSongs() is the single entry point. It is idempotent (a persisted cursor means a message is
// only ever handled once, across restarts too), safe to call concurrently, and never throws.

import { resolveUserName } from "./slack-users";
import { llmInfo, resolveSongRequest, type LinkPreview } from "./song-resolver";
import { readJson, writeJson } from "./songs-store";
import {
  PLAYLIST_SCOPES,
  QUEUE_SCOPES,
  SpotifyError,
  addToPlaylist,
  addToQueue,
  createPlaylist,
  listDevices,
  parsePlaylistId,
  playlistTrackIds,
  redirectUri,
  spotifyConnection,
  type SpotifyConnection,
  type Track,
} from "./spotify";

const STATE_FILE = "songs.json";
const SLACK_TIMEOUT_MS = 10_000;
/** How many pending requests one run works on (each may need two Claude calls). */
const MAX_PER_RUN = 5;
const MAX_PENDING = 50;
const MAX_LOG = 50;
const MIN_RUN_INTERVAL_MS = 5_000;
const SLACK_ERROR_BACKOFF_MS = 60_000;
const DEFAULT_MAX_AGE_MINUTES = 30;
const DEFAULT_POLL_SECONDS = 20;
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
  attachments?: Array<{
    service_name?: string;
    title?: string;
    author_name?: string;
    from_url?: string;
    original_url?: string;
  }>;
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
  rawText: string;
  previews: LinkPreview[];
  postedAt: string;
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
  claude: { route: "api" | "cli" | "none"; model: string; help: string | null };
  loop: { running: boolean; everySeconds: number };
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
  timer?: ReturnType<typeof setInterval>;
  tick?: () => void;
  slackRetryAt: number;
  slackCanRead: boolean | null;
  slackError: string | null;
  spotifyProblem: string | null;
  spotifyHelp: string | null;
  seedRetryAt: number;
};
const globalStore = globalThis as typeof globalThis & { __babSongs?: Runtime };
const runtime: Runtime = (globalStore.__babSongs ??= {
  lastRunAt: 0,
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
  return value === "queue" || value === "both" ? value : "playlist";
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
  return Math.max(seconds, 10);
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
  return { version: 1, channel, cursor: null, pending: [], log: [], playlist: null, lastPollAt: null, lastSyncAt: null };
}

async function loadState(channel: string | null): Promise<SongsState> {
  const stored = await readJson<Partial<SongsState>>(STATE_FILE);
  if (!stored || stored.version !== 1) return emptyState(channel);
  const state: SongsState = {
    ...emptyState(channel),
    ...stored,
    pending: Array.isArray(stored.pending) ? stored.pending : [],
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

async function slackCall<T>(method: string, params: Record<string, string>, post = false): Promise<T> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new SlackError("token_missing");

  const url = new URL(`https://slack.com/api/${method}`);
  if (!post) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response;
  try {
    response = await fetch(url, {
      method: post ? "POST" : "GET",
      headers: post
        ? { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }
        : { Authorization: `Bearer ${token}` },
      body: post ? JSON.stringify(params) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SlackError(timedOut ? "timeout" : "network_error");
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    throw new SlackError("rate_limited", null, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null);
  }
  if (!response.ok) throw new SlackError(`http_${response.status}`);

  const payload = (await response.json()) as T & { ok: boolean; error?: string; needed?: string };
  if (!payload.ok) throw new SlackError(payload.error ?? "unknown", payload.needed ?? null);
  return payload;
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

/** Reads messages newer than the cursor into state.pending. Returns false when Slack could not be read. */
async function pollSlack(state: SongsState, channel: string): Promise<boolean> {
  if (Date.now() < runtime.slackRetryAt) return false;
  try {
    if (state.cursor === null) {
      // First ever read: remember where the channel is now and do not touch the backlog.
      const payload = await slackCall<{ messages?: SlackMessage[] }>("conversations.history", { channel, limit: "1" });
      state.cursor = payload.messages?.[0]?.ts ?? "0";
    } else {
      const payload = await slackCall<{ messages?: SlackMessage[] }>("conversations.history", {
        channel,
        oldest: state.cursor,
        inclusive: "false",
        limit: "100",
      });
      // Newest first from Slack; handle oldest first so requests are added in the order asked.
      const fresh = (payload.messages ?? [])
        .filter((message): message is SlackMessage & { ts: string } => Boolean(message.ts) && compareTs(message.ts as string, state.cursor as string) > 0)
        .sort((a, b) => compareTs(a.ts, b.ts));

      for (const message of fresh) {
        state.cursor = message.ts;
        if (!isCandidate(message)) continue;
        if (state.pending.some((request) => request.ts === message.ts) || state.log.some((result) => result.id.split("#")[0] === message.ts)) {
          continue;
        }
        const request: PendingRequest = {
          id: message.ts,
          ts: message.ts,
          user: message.user,
          userName: null,
          text: displayText(message.text ?? ""),
          rawText: (message.text ?? "").slice(0, 4_000),
          previews: (message.attachments ?? [])
            .filter((attachment) => attachment.title)
            .slice(0, 3)
            .map((attachment) => ({
              service: attachment.service_name ?? null,
              title: attachment.title ?? null,
              author: attachment.author_name ?? null,
              url: attachment.from_url ?? attachment.original_url ?? null,
            })),
          postedAt: tsToIso(message.ts),
          attempts: 0,
          nextAttemptAt: 0,
          waitingFor: null,
          detail: null,
        };
        if (Date.now() - Number(message.ts) * 1000 > maxAgeMs()) {
          // Posted while the server was off, long enough ago that playing it now would be a surprise.
          finish(state, request, { status: "expired", reason: "too_old", outcome: "Posted too long ago to act on." });
          continue;
        }
        if (state.pending.length >= MAX_PENDING) {
          finish(state, request, { status: "failed", reason: "too_many_pending", outcome: "Too many requests are waiting." });
          continue;
        }
        request.userName = await resolveUserName(message.user);
        state.pending.push(request);
      }
    }
    state.lastPollAt = new Date().toISOString();
    runtime.slackCanRead = true;
    runtime.slackError = null;
    return true;
  } catch (error) {
    const slackError = error instanceof SlackError ? error : new SlackError("unknown");
    runtime.slackCanRead = false;
    runtime.slackError = slackError.needed ? `${slackError.code} (needs ${slackError.needed})` : slackError.code;
    runtime.slackRetryAt = Date.now() + Math.max(SLACK_ERROR_BACKOFF_MS, slackError.retryAfterMs ?? 0);
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

function trackLabel(track: Track | undefined): string {
  if (!track) return "that song";
  return track.artists.length > 0 ? `${track.name} — ${track.artists.join(", ")}` : track.name;
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
    track: summarize(request.track),
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
  // Chatter is never answered; only real requests get a reply, and only when replies are enabled.
  if (REPLY_STATUSES.has(result.status) || result.reason === "not_found") {
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
  "premium_required",
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
      return "Adding to the queue needs Spotify Premium on the connected account. Use SPOTIFY_SONGS_MODE=playlist instead, or upgrade.";
    case "no_active_device":
      return "Nothing is playing on Spotify. Start playback on this computer and waiting requests will be queued.";
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
    return { done: true };
  } catch (error) {
    const { code, detail } = errorCode(error, "queue_failed");
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

async function deliver(state: SongsState, request: PendingRequest, track: Track, context: RunContext): Promise<void> {
  const label = trackLabel(track);

  if (context.mode !== "queue") {
    const step = await deliverToPlaylist(state, request, track);
    if (!step.done) {
      if (BLOCKING.has(step.code)) block(context, request, step.code, step.detail);
      else backoff(request, step.code, step.detail);
      return;
    }
    if (context.mode === "playlist") {
      await finishAndReply(
        state,
        request,
        request.playlist === "duplicate"
          ? { status: "duplicate", reason: "already_in_playlist", outcome: `Already in the playlist: ${label}` }
          : { status: "added", reason: null, outcome: `Added to the playlist: ${label}` },
      );
      return;
    }
  }

  const queued = await deliverToQueue(state, request, track);

  if (context.mode === "both") {
    // The playlist step is already done, so the request is finished whatever the queue says.
    const inPlaylist = request.playlist === "duplicate" ? "Already in the playlist" : "Added to the playlist";
    await finishAndReply(
      state,
      request,
      queued.done
        ? { status: "queued", reason: null, outcome: `${inPlaylist} and queued: ${label}`, queue: "queued" }
        : {
            status: request.playlist === "duplicate" ? "duplicate" : "added",
            reason: null,
            outcome: `${inPlaylist}: ${label} (not queued: ${queued.code.replace(/_/g, " ")})`,
            queue: queued.code,
          },
    );
    return;
  }

  if (queued.done) {
    await finishAndReply(state, request, { status: "queued", reason: null, outcome: `Queued: ${label}`, queue: "queued" });
    return;
  }
  if (queued.code === "interrupted") {
    await finishAndReply(state, request, {
      status: "failed",
      reason: "interrupted",
      outcome: `Could not confirm that ${label} was queued; not retried.`,
      queue: "interrupted",
    });
    return;
  }
  if (BLOCKING.has(queued.code)) {
    block(context, request, queued.code, queued.code === "no_active_device" ? await describeDevices() : queued.detail);
    return;
  }
  backoff(request, queued.code, queued.detail);
}

async function processPending(state: SongsState, context: RunContext): Promise<void> {
  let handled = 0;
  // Index loop: resolving a message with several links inserts extra requests right after it.
  for (let index = 0; index < state.pending.length; index += 1) {
    const request = state.pending[index];

    if (Date.now() - Date.parse(request.postedAt) > maxAgeMs()) {
      const why = request.waitingFor ?? "not_processed_in_time";
      await finishAndReply(state, request, {
        status: "expired",
        reason: why,
        outcome: `Gave up after waiting (${why.replace(/_/g, " ")}).`,
      });
      index -= 1;
      continue;
    }
    if (context.blocker) {
      request.waitingFor = context.blocker.code;
      request.detail = context.blocker.detail ?? spotifyHelp(context.blocker.code);
      continue;
    }
    if (Date.now() < request.nextAttemptAt) continue;
    if (handled >= MAX_PER_RUN) break;
    handled += 1;

    if (!request.track) {
      const resolution = await resolveSongRequest(request.rawText, request.previews);
      if (resolution.kind === "retry") {
        if (BLOCKING.has(resolution.reason)) block(context, request, resolution.reason, null);
        else backoff(request, resolution.reason, resolution.detail);
        await saveState(state);
        continue;
      }
      if (resolution.kind === "skip") {
        await finishAndReply(state, request, {
          status: "skipped",
          reason: resolution.reason,
          outcome: resolution.reason === "not_found" ? `Couldn't find that one on Spotify. ${resolution.detail}` : resolution.detail,
        });
        await saveState(state);
        index -= 1;
        continue;
      }
      const [first, ...rest] = resolution.tracks;
      request.track = first;
      const extras = rest.map((track, offset): PendingRequest => ({ ...request, id: `${request.ts}#${offset + 2}`, track }));
      state.pending.splice(index + 1, 0, ...extras);
      await saveState(state);
    }

    const before = state.pending.length;
    await deliver(state, request, request.track, context);
    await saveState(state);
    if (state.pending.length < before) index -= 1;
  }
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
  let claude: ReturnType<typeof llmInfo> = { route: "none", model: "" };
  try {
    state = await loadState(channel);
    connection = await spotifyConnection();
    claude = llmInfo();
  } catch {
    // fall through with the empty defaults
  }

  const missing = missingScopes(connection, mode);
  const spotifyProblem = !connection.configured
    ? "not_configured"
    : connection.loginExpired
      ? "login_expired"
      : !connection.connected
        ? "not_connected"
        : missing.length > 0
          ? "insufficient_scope"
          : runtime.spotifyProblem;
  const spotifyHelpText = spotifyProblem
    ? spotifyProblem === runtime.spotifyProblem && runtime.spotifyHelp
      ? runtime.spotifyHelp
      : spotifyHelp(spotifyProblem) + (missing.length > 0 ? ` Missing: ${missing.join(", ")}.` : "")
    : null;

  const slackError = slackConfigured ? runtime.slackError : null;
  const claudeHelp =
    claude.route === "none"
      ? "No Claude access: set ANTHROPIC_API_KEY in .env.local or install the claude CLI. Until then only Spotify track links work."
      : null;

  const todo: string[] = [];
  if (!slackConfigured) todo.push("Set SLACK_BOT_TOKEN and SLACK_SONGS_CHANNEL_ID in .env.local.");
  else if (slackError) todo.push(slackHelp(slackError, channel) ?? slackError);
  if (spotifyHelpText) todo.push(spotifyHelpText);
  if (claudeHelp) todo.push(claudeHelp);

  const unconfigured = !slackConfigured || !connection.configured;
  const playlist = mode === "queue" ? null : state.playlist;

  return {
    status: unconfigured ? "unconfigured" : todo.length > 0 ? "needs_attention" : "ok",
    message: todo.length > 0 ? todo.join(" ") : "Listening for song requests.",
    slack: {
      configured: slackConfigured,
      channel,
      canRead: slackConfigured ? runtime.slackCanRead : null,
      error: slackError,
      help: slackHelp(slackError, channel),
      lastPollAt: state.lastPollAt,
      replyInThread: replyEnabled(),
    },
    spotify: {
      configured: connection.configured,
      connected: connection.connected,
      mode,
      loginUrl: new URL("/api/spotify/login", redirectUri()).toString(),
      redirectUri: redirectUri(),
      playlist: playlist
        ? {
            id: playlist.id,
            url: `https://open.spotify.com/playlist/${playlist.id}`,
            name: playlist.name,
            source: playlist.source,
            knownTracks: playlist.trackIds.length,
          }
        : null,
      missingScopes: missing,
      problem: spotifyProblem,
      help: spotifyHelpText,
    },
    claude: { ...claude, help: claudeHelp },
    loop: { running: Boolean(runtime.timer), everySeconds },
    lastSyncAt: state.lastSyncAt,
    pending: state.pending.map((request) => ({
      id: request.id,
      user: request.user,
      userName: request.userName,
      text: request.text,
      postedAt: request.postedAt,
      track: summarize(request.track),
      waitingFor: request.waitingFor,
      detail: request.detail,
      attempts: request.attempts,
    })),
    recent: state.log.slice(0, 20),
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
  void syncSongs();
};

/**
 * Starts the background poll (every SONGS_POLL_SECONDS, default 20; 0 disables it). Safe to call
 * repeatedly: there is one timer per server process.
 */
export function ensureSongsLoop(): boolean {
  const seconds = pollSeconds();
  if (seconds === 0) return false;
  if (!runtime.timer) {
    runtime.timer = setInterval(() => runtime.tick?.(), seconds * 1000);
    runtime.timer.unref?.();
  }
  return true;
}
