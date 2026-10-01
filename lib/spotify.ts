// Spotify Web API client for song requests: OAuth (Authorization Code flow), token refresh, track
// search, "add to playlist" and "add to queue". The Web API is the only way to do either; the
// macOS app's AppleScript dictionary has play/pause/next/play track but no queue or playlist
// command, and Spotify exposes no API at all for Jams.
//
// Needs a Spotify developer app (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET) and a one-time login at
// /api/spotify/login. Queueing requires Spotify Premium and an active device; playlists do not.

import { randomBytes } from "node:crypto";
import { readJson, writeJson } from "./songs-store";

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API_URL = "https://api.spotify.com/v1";
const TOKEN_FILE = "spotify.json";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RATE_LIMIT_PAUSE_MS = 15 * 60_000;

/** Everything any mode needs, requested up front so switching modes never needs a second login. */
export const SPOTIFY_SCOPES = [
  "user-modify-playback-state",
  "user-read-playback-state",
  "user-read-currently-playing",
  "playlist-modify-public",
  "playlist-modify-private",
  "playlist-read-private",
];

export const PLAYLIST_SCOPES = ["playlist-modify-public", "playlist-modify-private"];
export const QUEUE_SCOPES = ["user-modify-playback-state"];

/** Spotify refuses `localhost` redirect URIs; plain http is only allowed for the loopback IP form. */
export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:3000/api/spotify/callback";

export type SpotifyErrorCode =
  | "not_configured"
  | "not_connected"
  /** The stored login no longer works (revoked / app secret changed): log in again. */
  | "login_expired"
  | "rate_limited"
  | "no_active_device"
  | "premium_required"
  /** The stored login was granted fewer permissions than this call needs: log in again. */
  | "insufficient_scope"
  | "forbidden"
  | "not_found"
  | "timeout"
  | "network_error"
  | `http_${number}`
  | `oauth_${string}`;

export class SpotifyError extends Error {
  readonly code: SpotifyErrorCode;
  readonly detail: string | null;
  readonly retryAfterMs: number | null;

  constructor(code: SpotifyErrorCode, detail: string | null = null, retryAfterMs: number | null = null) {
    super(detail ? `Spotify: ${code} (${detail})` : `Spotify: ${code}`);
    this.code = code;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
  }
}

export type Track = {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string | null;
  year: string | null;
  durationMs: number | null;
  explicit: boolean;
};

export type SpotifyDevice = { id: string | null; name: string; type: string; isActive: boolean };

type StoredTokens = {
  refresh_token: string;
  access_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  scope?: string;
  connected_at?: string;
  /** Set when Spotify rejects the refresh token; cleared by logging in again. */
  invalid?: boolean;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

// Kept on globalThis so dev-mode module reloads share one rate-limit window and one refresh.
type Shared = { pausedUntil: number; refreshing?: Promise<string> };
const globalStore = globalThis as typeof globalThis & { __babSpotify?: Shared };
const shared: Shared = (globalStore.__babSpotify ??= { pausedUntil: 0 });

export function spotifyConfig(): { clientId: string; clientSecret: string; redirectUri: string } | null {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri: process.env.SPOTIFY_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI };
}

export function redirectUri(): string {
  return process.env.SPOTIFY_REDIRECT_URI?.trim() || DEFAULT_REDIRECT_URI;
}

export type SpotifyConnection = {
  configured: boolean;
  connected: boolean;
  /** True when a stored login exists but Spotify rejected it. */
  loginExpired: boolean;
  connectedAt: string | null;
  /** Scopes granted at login. */
  scopes: string[];
  /** Until when calls are paused after a 429, or null. */
  rateLimitedUntil: string | null;
};

export async function spotifyConnection(): Promise<SpotifyConnection> {
  const tokens = await readJson<StoredTokens>(TOKEN_FILE);
  const hasLogin = Boolean(tokens?.refresh_token);
  return {
    configured: spotifyConfig() !== null,
    connected: spotifyConfig() !== null && hasLogin && !tokens?.invalid,
    loginExpired: hasLogin && Boolean(tokens?.invalid),
    connectedAt: tokens?.connected_at ?? null,
    scopes: (tokens?.scope ?? "").split(/\s+/).filter(Boolean),
    rateLimitedUntil: Date.now() < shared.pausedUntil ? new Date(shared.pausedUntil).toISOString() : null,
  };
}

// --- OAuth -----------------------------------------------------------------------------------

export function newOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

export function authorizeUrl(state: string): string {
  const config = spotifyConfig();
  if (!config) throw new SpotifyError("not_configured");
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", SPOTIFY_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

function failureCode(error: unknown): SpotifyErrorCode {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
    ? "timeout"
    : "network_error";
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const config = spotifyConfig();
  if (!config) throw new SpotifyError("not_configured");

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SpotifyError(failureCode(error));
  }

  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    // invalid_grant: bad/expired code or revoked refresh token. invalid_client: wrong id/secret.
    if (payload.error) throw new SpotifyError(`oauth_${payload.error}`, payload.error_description ?? null);
    throw new SpotifyError(`http_${response.status}`);
  }
  return payload;
}

/** Trades the callback `code` for tokens and stores them (file mode 600). */
export async function exchangeCode(code: string): Promise<void> {
  const config = spotifyConfig();
  if (!config) throw new SpotifyError("not_configured");
  const payload = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri,
  });
  if (!payload.refresh_token) throw new SpotifyError("oauth_no_refresh_token");
  const tokens: StoredTokens = {
    refresh_token: payload.refresh_token,
    access_token: payload.access_token,
    expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
    scope: payload.scope,
    connected_at: new Date().toISOString(),
  };
  await writeJson(TOKEN_FILE, tokens, 0o600);
}

async function refreshAccessToken(tokens: StoredTokens): Promise<string> {
  try {
    const payload = await tokenRequest({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    const updated: StoredTokens = {
      ...tokens,
      // Spotify only sometimes rotates the refresh token; keep the old one when it doesn't.
      refresh_token: payload.refresh_token || tokens.refresh_token,
      access_token: payload.access_token,
      expires_at: Date.now() + (payload.expires_in ?? 3600) * 1000,
      scope: payload.scope ?? tokens.scope,
      invalid: false,
    };
    await writeJson(TOKEN_FILE, updated, 0o600);
    return payload.access_token as string;
  } catch (error) {
    if (error instanceof SpotifyError && error.code === "oauth_invalid_grant") {
      await writeJson(TOKEN_FILE, { ...tokens, access_token: undefined, invalid: true }, 0o600);
      throw new SpotifyError("login_expired", error.detail);
    }
    throw error;
  }
}

async function accessToken(forceRefresh = false): Promise<string> {
  if (!spotifyConfig()) throw new SpotifyError("not_configured");
  const tokens = await readJson<StoredTokens>(TOKEN_FILE);
  if (!tokens?.refresh_token) throw new SpotifyError("not_connected");
  if (tokens.invalid) throw new SpotifyError("login_expired");

  if (!forceRefresh && tokens.access_token && Date.now() < (tokens.expires_at ?? 0) - 60_000) {
    return tokens.access_token;
  }
  // One refresh at a time: concurrent callers share it instead of racing on the token file.
  shared.refreshing ??= refreshAccessToken(tokens).finally(() => {
    shared.refreshing = undefined;
  });
  return shared.refreshing;
}

// --- API calls -------------------------------------------------------------------------------

type ApiError = { error?: { status?: number; message?: string; reason?: string } };

async function api<T>(
  method: "GET" | "POST",
  path: string,
  params: Record<string, string> = {},
  body?: unknown,
): Promise<T | null> {
  if (Date.now() < shared.pausedUntil) {
    throw new SpotifyError("rate_limited", null, shared.pausedUntil - Date.now());
  }

  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  let response: Response | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Second pass only happens after a 401: the stored access token was stale, so force a refresh.
    const token = await accessToken(attempt === 1);
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SpotifyError(failureCode(error));
    }
    if (response.status !== 401) break;
  }
  if (!response) throw new SpotifyError("network_error");

  if (response.ok) {
    if (response.status === 204) return null;
    // Player commands answer 200/204 with an empty or non-JSON body.
    return (await response.json().catch(() => null)) as T | null;
  }

  const payload = (await response.json().catch(() => ({}))) as ApiError;
  const reason = payload.error?.reason ?? "";
  const message = payload.error?.message ?? null;

  if (response.status === 429) {
    const seconds = Number(response.headers.get("retry-after"));
    const pause = Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000, MAX_RATE_LIMIT_PAUSE_MS);
    shared.pausedUntil = Math.max(shared.pausedUntil, Date.now() + pause);
    throw new SpotifyError("rate_limited", message, pause);
  }
  if (response.status === 401) throw new SpotifyError("login_expired", message);
  if (response.status === 403) {
    if (/insufficient client scope/i.test(message ?? "")) throw new SpotifyError("insufficient_scope", message);
    const premium = reason === "PREMIUM_REQUIRED" || /premium/i.test(message ?? "");
    throw new SpotifyError(premium ? "premium_required" : "forbidden", message);
  }
  if (response.status === 404) {
    const noDevice = reason === "NO_ACTIVE_DEVICE" || /no active device|device not found/i.test(message ?? "");
    throw new SpotifyError(noDevice ? "no_active_device" : "not_found", message);
  }
  throw new SpotifyError(`http_${response.status}`, message);
}

type ApiTrack = {
  id?: string;
  uri?: string;
  name?: string;
  type?: string;
  explicit?: boolean;
  duration_ms?: number;
  artists?: Array<{ name?: string }>;
  album?: { name?: string; release_date?: string };
};

function toTrack(item: ApiTrack | null | undefined): Track | null {
  if (!item?.id || !item.name || (item.type && item.type !== "track")) return null;
  return {
    id: item.id,
    uri: item.uri ?? `spotify:track:${item.id}`,
    name: item.name,
    artists: (item.artists ?? []).map((artist) => artist.name ?? "").filter(Boolean),
    album: item.album?.name ?? null,
    year: item.album?.release_date?.slice(0, 4) || null,
    durationMs: typeof item.duration_ms === "number" ? item.duration_ms : null,
    explicit: Boolean(item.explicit),
  };
}

/** Top track matches for a free-text query. Spotify caps `limit` at 10. */
export async function searchTracks(query: string, limit = 6): Promise<Track[]> {
  const payload = await api<{ tracks?: { items?: Array<ApiTrack | null> } }>("GET", "/search", {
    q: query.slice(0, 200),
    type: "track",
    limit: String(Math.min(Math.max(limit, 1), 10)),
  });
  const tracks: Track[] = [];
  for (const item of payload?.tracks?.items ?? []) {
    const track = toTrack(item);
    if (track) tracks.push(track);
  }
  return tracks;
}

/** Track metadata by ID, or null if Spotify doesn't know the ID. */
export async function getTrack(id: string): Promise<Track | null> {
  try {
    return toTrack(await api<ApiTrack>("GET", `/tracks/${encodeURIComponent(id)}`));
  } catch (error) {
    if (error instanceof SpotifyError && (error.code === "not_found" || error.code === "http_400")) return null;
    throw error;
  }
}

/**
 * Adds a track to the end of the user's queue on whichever device is currently active.
 * Throws SpotifyError("no_active_device") when nothing is playing anywhere.
 *
 * No `device_id` is passed on purpose: the queue belongs to the active playback session, and
 * targeting an idle device fails the same way, so "active device" is the only reliable target.
 */
export async function addToQueue(trackId: string): Promise<void> {
  await api<unknown>("POST", "/me/player/queue", { uri: `spotify:track:${trackId}` });
}

/** Devices Spotify currently sees for the account (for diagnostics only). */
export async function listDevices(): Promise<SpotifyDevice[]> {
  const payload = await api<{
    devices?: Array<{ id?: string | null; name?: string; type?: string; is_active?: boolean }>;
  }>("GET", "/me/player/devices");
  return (payload?.devices ?? []).map((device) => ({
    id: device.id ?? null,
    name: device.name ?? "Unknown device",
    type: device.type ?? "Unknown",
    isActive: Boolean(device.is_active),
  }));
}

// --- Playlists -------------------------------------------------------------------------------

const PLAYLIST_PAGE_SIZE = 50;

/** Accepts a bare playlist ID, a spotify:playlist: URI or an open.spotify.com/playlist/... URL. */
export function parsePlaylistId(value: string | undefined | null): string | null {
  const input = value?.trim();
  if (!input) return null;
  const match =
    input.match(/^([A-Za-z0-9]{22})$/) ??
    input.match(/^spotify:playlist:([A-Za-z0-9]{22})$/) ??
    input.match(/open\.spotify\.com\/(?:intl-[a-z-]+\/)?playlist\/([A-Za-z0-9]{22})(?![A-Za-z0-9])/);
  return match ? match[1] : null;
}

/** Creates a private playlist on the logged-in account and returns its ID. */
export async function createPlaylist(name: string, description: string): Promise<{ id: string; name: string }> {
  const payload = await api<{ id?: string; name?: string }>("POST", "/me/playlists", {}, {
    name,
    description,
    public: false,
  });
  if (!payload?.id) throw new SpotifyError("http_502", "Spotify did not return a playlist ID");
  return { id: payload.id, name: payload.name ?? name };
}

/** Appends one track to the end of a playlist. Works with nothing playing. */
export async function addToPlaylist(playlistId: string, trackId: string): Promise<void> {
  await api<unknown>("POST", `/playlists/${encodeURIComponent(playlistId)}/items`, {}, {
    uris: [`spotify:track:${trackId}`],
  });
}

/**
 * Track IDs currently in a playlist, reading at most `maxTracks` (newest entries are at the end,
 * so a longer playlist is read from the tail). `complete` is false when the cap cut it short.
 */
export async function playlistTrackIds(
  playlistId: string,
  maxTracks = 1_000,
): Promise<{ ids: string[]; total: number; complete: boolean }> {
  type Page = {
    total?: number;
    items?: Array<{ item?: { id?: string | null } | null; track?: { id?: string | null } | null } | null>;
  };
  const path = `/playlists/${encodeURIComponent(playlistId)}/items`;
  const ids = new Set<string>();

  const first = await api<Page>("GET", path, { limit: String(PLAYLIST_PAGE_SIZE), offset: "0" });
  const total = first?.total ?? first?.items?.length ?? 0;
  const collect = (page: Page | null) => {
    for (const entry of page?.items ?? []) {
      const id = entry?.item?.id ?? entry?.track?.id;
      if (id) ids.add(id);
    }
  };

  const start = Math.max(0, total - maxTracks);
  if (start === 0) collect(first);
  for (let offset = start === 0 ? PLAYLIST_PAGE_SIZE : start; offset < total; offset += PLAYLIST_PAGE_SIZE) {
    collect(await api<Page>("GET", path, { limit: String(PLAYLIST_PAGE_SIZE), offset: String(offset) }));
  }
  return { ids: [...ids], total, complete: start === 0 };
}
