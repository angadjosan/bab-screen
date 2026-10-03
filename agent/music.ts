// Music actions shared by the rules fast path and the tools: playback through the Spotify app's
// AppleScript dictionary on this Mac, and queueing through the Web API by way of the Next app
// (POST /api/spotify/agent, 127.0.0.1 only, x-screen-secret), which stays the only process that
// refreshes and writes the Spotify token file (.data/spotify.json).

import { execFile } from "node:child_process";
import { isDucked, restoreVolume, setRestoreVolume } from "../lib/duck";
import { getNowPlaying } from "../lib/now-playing";
import type { Track } from "../lib/spotify";
import { config } from "./config";

export type PlaybackAction = "play" | "pause" | "next" | "previous" | "volume_up" | "volume_down" | "volume_set" | "status";

export type MusicResult = { ok: boolean; message: string; detail?: unknown };

const VOLUME_STEP = 15;

function osascript(script: string): Promise<{ ok: boolean; out: string; permission: boolean }> {
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 4_000 }, (error, stdout, stderr) => {
      const text = `${String(stderr)} ${error?.message ?? ""}`;
      resolve({ ok: !error, out: String(stdout).trim(), permission: /-1743|not authori[sz]ed/i.test(text) });
    });
  });
}

/** Runs a command in Spotify only if it is already running (never launches it). Returns null when it is not. */
async function spotify(command: string): Promise<{ ok: boolean; out: string; permission: boolean } | null> {
  const result = await osascript(`if application "Spotify" is running then\ntell application "Spotify" to ${command}\nelse\nreturn "__not_running__"\nend if`);
  if (result.out === "__not_running__") return null;
  return result;
}

async function currentVolume(): Promise<number | null> {
  if (isDucked()) return restoreVolume();
  const result = await spotify("get sound volume");
  const value = Number(result?.out);
  return result?.ok && Number.isFinite(value) ? value : null;
}

async function setVolume(volume: number, dryRun: boolean): Promise<MusicResult> {
  const target = Math.max(0, Math.min(100, Math.round(volume)));
  if (dryRun) return { ok: true, message: `Volume ${target} (dry run)` };
  // While Jarvis is talking Spotify is ducked: change what it comes back to instead.
  if (setRestoreVolume(target)) return { ok: true, message: `Volume ${target}` };
  const result = await spotify(`set sound volume to ${target}`);
  if (!result) return { ok: false, message: "Spotify isn't open on the Mac." };
  if (!result.ok) return { ok: false, message: result.permission ? "macOS hasn't allowed me to control Spotify (Automation permission)." : "Spotify didn't take that." };
  return { ok: true, message: `Volume ${target}` };
}

export async function playback(action: PlaybackAction, options: { volume?: number; dryRun?: boolean } = {}): Promise<MusicResult> {
  const dryRun = options.dryRun ?? config.dryRun();
  if (action === "status") {
    const now = await getNowPlaying();
    const volume = await currentVolume();
    return { ok: true, message: now.title ? `${now.status}: ${now.title} by ${now.artists ?? "unknown"}` : now.status, detail: { ...now, volume } };
  }
  if (action === "volume_set") return setVolume(options.volume ?? 50, dryRun);
  if (action === "volume_up" || action === "volume_down") {
    const volume = dryRun ? 50 : await currentVolume();
    if (volume === null) return { ok: false, message: "Spotify isn't open on the Mac." };
    return setVolume(volume + (action === "volume_up" ? VOLUME_STEP : -VOLUME_STEP), dryRun);
  }
  const command = { play: "play", pause: "pause", next: "next track", previous: "previous track" }[action];
  const done = { play: "Playing.", pause: "Paused.", next: "Skipped.", previous: "Back one." }[action];
  if (dryRun) return { ok: true, message: `${done} (dry run)` };
  const result = await spotify(command);
  if (!result) return { ok: false, message: "Spotify isn't open on the Mac." };
  if (!result.ok) return { ok: false, message: result.permission ? "macOS hasn't allowed me to control Spotify (Automation permission)." : "Spotify didn't take that." };
  return { ok: true, message: done };
}

const describe = (track: Track) => `${track.name} by ${track.artists.join(", ") || "unknown"}`;

function spotifyProblem(code: string): string {
  switch (code) {
    case "not_configured":
    case "not_connected":
    case "login_expired":
    case "insufficient_scope":
      return "Spotify isn't connected: open http://127.0.0.1:3000/api/spotify/login on the Mac.";
    case "no_active_device":
      return "Nothing is playing, so there's no queue to add to. Start something in Spotify first.";
    case "premium_required":
      return "Spotify says queueing needs Premium on this account.";
    case "rate_limited":
      return "Spotify is rate limiting us. Try again in a bit.";
    case "next_unreachable":
      return "The TV app isn't answering, so I can't reach Spotify.";
    case "no_secret":
      return "SCREEN_SECRET isn't set, so the TV app won't take Spotify requests from me.";
    default:
      return `Spotify had a problem (${code.slice(0, 40)}).`;
  }
}

const SPOTIFY_TIMEOUT_MS = 15_000;

type SpotifyAnswer = { ok: boolean; error?: string; link?: boolean; track?: Track | null };

/** POST /api/spotify/agent on the Next app. Never throws; failures come back as {ok: false, error: code}. */
export async function spotifyViaNext(body: { op: "search"; query: string } | { op: "queue"; trackId: string }): Promise<SpotifyAnswer> {
  const secret = config.screenSecret();
  if (!secret) return { ok: false, error: "no_secret" };
  try {
    const response = await fetch(`${config.nextUrl()}/api/spotify/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-screen-secret": secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS),
    });
    const answer = (await response.json().catch(() => null)) as SpotifyAnswer | null;
    if (!answer || typeof answer !== "object") return { ok: false, error: `http_${response.status}` };
    if (!response.ok || !answer.ok) return { ok: false, error: typeof answer.error === "string" ? answer.error : `http_${response.status}` };
    return answer;
  } catch {
    return { ok: false, error: "next_unreachable" };
  }
}

/** Finds a track (a Spotify link, or a search) and adds it to the queue, both through the Next app. */
export async function queueTrack(query: string, options: { dryRun?: boolean } = {}): Promise<MusicResult> {
  const dryRun = options.dryRun ?? config.dryRun();
  if (dryRun && !process.env.SPOTIFY_CLIENT_ID) return { ok: true, message: `Queued: ${query} (dry run, no search)` };
  const found = await spotifyViaNext({ op: "search", query });
  if (!found.ok) return { ok: false, message: spotifyProblem(found.error ?? "unknown") };
  const track = found.track ?? null;
  if (!track) return { ok: false, message: found.link ? "That link isn't a Spotify track I can find." : `Couldn't find anything on Spotify for "${query}".` };
  if (dryRun) return { ok: true, message: `Queued: ${describe(track)} (dry run)`, detail: track };
  const queued = await spotifyViaNext({ op: "queue", trackId: track.id });
  if (!queued.ok) return { ok: false, message: spotifyProblem(queued.error ?? "unknown") };
  return { ok: true, message: `Queued: ${describe(track)}`, detail: track };
}
