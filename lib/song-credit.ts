// Who asked for the track that is playing: a read-only lookup in the song-request log (songs.json
// in the store, lib/store.ts). No Slack or Spotify call is made, and nothing here can throw.

import { modifiedAt, readJsonStrict } from "./store";

const STATE_FILE = "songs.json";
/** A request older than this is not credited: the same track coming up again a day later was not "queued by" them. */
export const CREDIT_MAX_AGE_MS = 12 * 60 * 60_000;

export type SongCredit = { queuedBy: string; queuedAt: string };

/** Per track ID, when it was queued and by whom. */
export type CreditIndex = Map<string, Array<{ by: string; at: number }>>;

const TRACK_ID = /^(?:spotify:track:|https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?track\/)?([A-Za-z0-9]{22})(?:[?#].*)?$/;

/** The bare 22-character ID from "spotify:track:<id>", a track link or a bare ID. Null for local files, ads and episodes. */
export function bareTrackId(value: unknown): string | null {
  return typeof value === "string" ? TRACK_ID.exec(value.trim())?.[1] ?? null : null;
}

/** Indexes the requests that really went into the play queue. Tolerates any shape: bad entries are skipped. */
export function buildCreditIndex(log: unknown): CreditIndex {
  const index: CreditIndex = new Map();
  if (!Array.isArray(log)) return index;
  for (const entry of log) {
    if (!entry || typeof entry !== "object") continue;
    const { status, queue, track, userName, finishedAt, postedAt } = entry as Record<string, unknown>;
    if (status !== "queued" && queue !== "queued") continue;
    const id = bareTrackId((track as { id?: unknown } | null)?.id);
    const by = typeof userName === "string" ? userName.trim() : "";
    // finishedAt is when it went into the queue.
    const at = Date.parse(typeof finishedAt === "string" ? finishedAt : typeof postedAt === "string" ? postedAt : "");
    if (!id || !by || !Number.isFinite(at)) continue;
    const list = index.get(id);
    if (list) list.push({ by, at });
    else index.set(id, [{ by, at }]);
  }
  return index;
}

/** The latest request for this exact track that is not in the future and not older than CREDIT_MAX_AGE_MS. */
export function pickCredit(index: CreditIndex, trackId: unknown, now: number): SongCredit | null {
  const id = bareTrackId(trackId);
  const list = id ? index.get(id) : undefined;
  if (!list) return null;
  let best: { by: string; at: number } | null = null;
  for (const entry of list) {
    if (entry.at > now || now - entry.at > CREDIT_MAX_AGE_MS) continue;
    if (!best || entry.at > best.at) best = entry;
  }
  return best ? { queuedBy: best.by, queuedAt: new Date(best.at).toISOString() } : null;
}

let cache: { key: string; index: CreditIndex } | null = null;
/** With Redis there is no modification time to compare, so the log is read at most this often. */
const REREAD_MS = 5_000;

// The log is re-parsed only when it has changed (the song job rewrites it about every 20 s): for
// files that costs one stat(); with Redis the copy is kept for REREAD_MS.
async function loadIndex(): Promise<CreditIndex | null> {
  try {
    const mtime = await modifiedAt(STATE_FILE);
    const key = mtime === null ? `t${Math.floor(Date.now() / REREAD_MS)}` : `m${mtime}`;
    if (cache?.key !== key) {
      const state = await readJsonStrict<{ log?: unknown }>(STATE_FILE);
      // No document: there are no requests.
      cache = state ? { key, index: buildCreditIndex(state.log) } : null;
    }
  } catch {
    // Unreadable or half-written: keep the last good copy.
  }
  return cache?.index ?? null;
}

/** Who queued this track through the Slack channel, or null. Never throws. */
export async function getSongCredit(trackId: string | null, now = Date.now()): Promise<SongCredit | null> {
  try {
    if (!bareTrackId(trackId)) return null;
    const index = await loadIndex();
    return index ? pickCredit(index, trackId, now) : null;
  } catch {
    return null;
  }
}
