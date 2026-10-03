import { execFile } from "node:child_process";
import { getSongCredit } from "./song-credit";
import { SpotifyError, currentlyPlaying, type CurrentlyPlaying } from "./spotify";

// What the Spotify account is playing, from the Web API (GET /me/player/currently-playing) with the
// login the song requests use (lib/spotify.ts, /api/spotify/login). That works wherever the server
// runs, Vercel included.
//
// Until Spotify is connected, a server on a Mac falls back to asking the Spotify desktop app on
// that Mac through its AppleScript dictionary (osascript, JXA), which needs no account at all.
// Read-only either way: nothing here launches Spotify or touches playback.

export type NowPlayingStatus = "playing" | "paused" | "stopped" | "not_running" | "unavailable";

export type NowPlaying = {
  status: NowPlayingStatus;
  reason?: "automation_permission" | "not_connected" | "login_expired" | "rate_limited" | "timeout" | "error";
  title: string | null;
  artists: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationMs: number | null;
  positionMs: number | null;
  trackId: string | null;
  /** Slack display name of whoever queued this track through the song-request channel; null when it got here another way. */
  queuedBy: string | null;
  queuedAt: string | null;
  fetchedAt: number;
};

// The Web API is shared by every screen and by the song requests; once every 3 s per server instance is plenty.
const CACHE_MS = 3_000;
// After a failure (not logged in, rate limited, the macOS permission prompt waiting for an answer) ask less often.
const FAILURE_CACHE_MS = 10_000;
const OSASCRIPT_TIMEOUT_MS = 4_000;
const SPOTIFY_BUNDLE_ID = "com.spotify.client";

// JXA rather than AppleScript so the fields come back as JSON: track names can hold any punctuation, newlines or emoji.
// `running()` does not launch the app, and nothing else is sent unless it is already running.
const READ_SCRIPT = `
function run(argv) {
  var app = Application(argv[0]);
  if (!app.running()) return JSON.stringify({ running: false });
  var out = { running: true };
  try {
    out.state = String(app.playerState());
    out.position = app.playerPosition();
  } catch (e) {
    return JSON.stringify({ running: true, error: String(e), errorNumber: e && e.errorNumber });
  }
  try {
    var t = app.currentTrack;
    out.track = { name: t.name(), artist: t.artist(), album: t.album(), artworkUrl: t.artworkUrl(), duration: t.duration(), id: t.id() };
  } catch (e) {
    out.trackError = String(e);
  }
  return JSON.stringify(out);
}`;

type Raw = {
  running?: boolean;
  state?: string;
  position?: unknown;
  error?: string;
  errorNumber?: unknown;
  trackError?: string;
  track?: { name?: unknown; artist?: unknown; album?: unknown; artworkUrl?: unknown; duration?: unknown; id?: unknown };
};

function run(file: string, args: string[], timeout: number) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
    execFile(file, args, { timeout, killSignal: "SIGKILL", maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      const failure = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
      resolve({
        code: failure ? (typeof failure.code === "number" ? failure.code : null) : 0,
        stdout: String(stdout),
        stderr: String(stderr) + (failure && typeof failure.code === "string" ? ` ${failure.code}` : ""),
        timedOut: Boolean(failure?.killed),
      });
    });
  });
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);
const isPermissionError = (message: string) => /-1743|not authori[sz]ed to send apple events/i.test(message);

function blank(status: NowPlayingStatus, reason?: NowPlaying["reason"]): NowPlaying {
  return { status, ...(reason ? { reason } : {}), title: null, artists: null, album: null, artworkUrl: null, durationMs: null, positionMs: null, trackId: null, queuedBy: null, queuedAt: null, fetchedAt: Date.now() };
}

async function readWebApi(): Promise<NowPlaying> {
  let playing: CurrentlyPlaying | null;
  try {
    playing = await currentlyPlaying();
  } catch (error) {
    const code = error instanceof SpotifyError ? error.code : "error";
    if (code === "not_connected" || code === "not_configured" || code === "insufficient_scope") return blank("unavailable", "not_connected");
    if (code === "login_expired") return blank("unavailable", "login_expired");
    if (code === "rate_limited") return blank("unavailable", "rate_limited");
    return blank("unavailable", code === "timeout" ? "timeout" : "error");
  }
  const track = playing?.item;
  const title = text(track?.name);
  // 204 (no active device) or an ad: nothing to show.
  if (!playing || !track || !title) return blank("stopped");
  const durationMs = count(track.durationMs);
  const positionMs = count(playing.progressMs);
  const artwork = text(track.artworkUrl);
  return {
    status: playing.isPlaying ? "playing" : "paused",
    title,
    artists: text(track.artists),
    album: text(track.album),
    artworkUrl: artwork && /^https:\/\//i.test(artwork) ? artwork : null,
    durationMs: durationMs && durationMs > 0 ? Math.round(durationMs) : null,
    positionMs: positionMs !== null && durationMs ? Math.min(positionMs, durationMs) : positionMs,
    trackId: text(track.uri) ?? text(track.id),
    queuedBy: null,
    queuedAt: null,
    fetchedAt: Date.now(),
  };
}

async function read(): Promise<NowPlaying> {
  const viaApi = await readWebApi();
  // On a Mac without a Spotify login, ask the desktop app instead, as this always did.
  if (viaApi.reason === "not_connected" && process.platform === "darwin" && !process.env.VERCEL) return readDesktopApp();
  return viaApi;
}

async function readDesktopApp(): Promise<NowPlaying> {
  // Cheap first check that cannot launch anything; pgrep exits 1 when there is no such process.
  const probe = await run("/usr/bin/pgrep", ["-x", "Spotify"], 2_000);
  if (probe.code === 1) return blank("not_running");

  const result = await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", READ_SCRIPT, SPOTIFY_BUNDLE_ID], OSASCRIPT_TIMEOUT_MS);
  if (result.timedOut) return blank("unavailable", "timeout");
  if (result.code !== 0) return blank("unavailable", isPermissionError(result.stderr) ? "automation_permission" : "error");

  let raw: Raw;
  try {
    raw = JSON.parse(result.stdout) as Raw;
  } catch {
    return blank("unavailable", "error");
  }
  if (!raw.running) return blank("not_running");
  if (raw.error) return blank("unavailable", isPermissionError(`${raw.error} ${String(raw.errorNumber)}`) ? "automation_permission" : "error");
  if (raw.trackError && isPermissionError(raw.trackError)) return blank("unavailable", "automation_permission");

  const status: NowPlayingStatus = raw.state === "playing" || raw.state === "paused" ? raw.state : "stopped";
  const track = raw.track;
  const title = text(track?.name);
  if (!track || !title) return blank("stopped");

  const artwork = text(track.artworkUrl);
  const durationMs = count(track.duration);
  const seconds = count(raw.position);
  const positionMs = seconds === null ? null : Math.round(seconds * 1000);
  return {
    status,
    title,
    artists: text(track.artist),
    album: text(track.album),
    // Local files, some podcasts and ads have no artwork (or a non-web one).
    artworkUrl: artwork && /^https?:\/\//i.test(artwork) ? artwork.replace(/^http:\/\//i, "https://") : null,
    durationMs: durationMs && durationMs > 0 ? Math.round(durationMs) : null,
    positionMs: positionMs !== null && durationMs ? Math.min(positionMs, durationMs) : positionMs,
    trackId: text(track.id),
    // Filled in per reply by getNowPlaying, from the song-request log.
    queuedBy: null,
    queuedAt: null,
    fetchedAt: Date.now(),
  };
}

let cached: NowPlaying | null = null;
let pending: Promise<NowPlaying> | null = null;

// One read at a time, and at most one every CACHE_MS however many clients poll.
export async function getNowPlaying(): Promise<NowPlaying> {
  const maxAge = cached?.status === "unavailable" ? FAILURE_CACHE_MS : CACHE_MS;
  if (!cached || Date.now() - cached.fetchedAt >= maxAge) {
    pending ??= read()
      .catch(() => blank("unavailable", "error"))
      .then((value) => {
        cached = value;
        pending = null;
        return value;
      });
    await pending;
  }
  const latest = cached as NowPlaying;
  // Looked up on every reply, not cached with the read: a request can be logged while its track is already playing.
  const credit = latest.status === "playing" || latest.status === "paused" ? await getSongCredit(latest.trackId) : null;
  const value: NowPlaying = { ...latest, queuedBy: credit?.queuedBy ?? null, queuedAt: credit?.queuedAt ?? null };
  // Carry the position forward to the moment of the reply so a cached read is not behind.
  const now = Date.now();
  if (value.status !== "playing" || value.positionMs === null) return { ...value, fetchedAt: now };
  const position = value.positionMs + (now - value.fetchedAt);
  return { ...value, positionMs: value.durationMs ? Math.min(position, value.durationMs) : position, fetchedAt: now };
}
