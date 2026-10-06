// Background jobs without a long-running process. Each job is a function that does one round of
// work and says when the next round is due. runJob runs it only when it is due and only on one
// instance at a time: the due time lives in the store, and the round runs under a lease (lib/store.ts).
//
// Rounds are started two ways, and both go through runJob, so they can never overlap:
//   - by the requests the screen makes anyway (each route kicks the jobs behind it, in the
//     background, so the reply never waits for them; see kickJobs in lib/tick.ts);
//   - by the cron route /api/cron/tick, which runs every job that is due.
// On the Mac the same code runs; the song-request poll also keeps its timer there (lib/songs.ts).

import { waitUntil } from "@vercel/functions";
import { acquireLease, readJson, writeJson, type Lease } from "./store";

export type JobSpec = {
  name: string;
  /** Longer than a round can take. A round that outlives it may overlap the next holder's. */
  leaseMs: number;
  /** Time between rounds when the round does not say otherwise. */
  everyMs: () => number;
  /** Time before a retry after a round that threw. */
  retryMs: number;
  /** False skips the job (unconfigured, or turned off). */
  enabled?: () => boolean;
  /** Skip rounds when no request has asked for this job's output for this long. */
  idleAfterMs?: number;
  /** One round. May return the time until the next one. */
  run: (lease: Lease) => Promise<number | void>;
};

export type JobOutcome = "ran" | "failed" | "not_due" | "busy" | "idle" | "off";

type JobState = { lastRunAt: number; nextDueAt: number; ok: boolean; error: string | null; ms: number };

const stateName = (job: string) => `jobs/${job}.json`;
const seenName = (job: string) => `jobs/${job}.seen.json`;
/** How often an instance records that a screen is asking for a job's output. */
const SEEN_WRITE_MS = 60_000;

// Per instance: the due time last read, so a poll between rounds costs no store read.
const globalStore = globalThis as typeof globalThis & { __babJobs?: { due: Map<string, number>; seen: Map<string, number> } };
const local = (globalStore.__babJobs ??= { due: new Map(), seen: new Map() });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0];

async function dueAt(job: string): Promise<number> {
  const state = await readJson<JobState>(stateName(job));
  const due = typeof state?.nextDueAt === "number" ? state.nextDueAt : 0;
  local.due.set(job, due);
  return due;
}

/** Makes the job due now, e.g. after its settings changed. */
export async function markDue(job: string): Promise<void> {
  local.due.delete(job);
  const state = await readJson<JobState>(stateName(job));
  if (state) await writeJson(stateName(job), { ...state, nextDueAt: 0 });
}

/** Notes that a screen asked for this job's output (written at most once a minute per instance). */
export async function noteDemand(job: string): Promise<void> {
  const now = Date.now();
  if (now - (local.seen.get(job) ?? 0) < SEEN_WRITE_MS) return;
  local.seen.set(job, now);
  await writeJson(seenName(job), { at: now });
}

/** Runs one round of the job if it is due and nobody else is running it. Never throws. */
export async function runJob(spec: JobSpec, options: { force?: boolean } = {}): Promise<JobOutcome> {
  try {
    if (spec.enabled && !spec.enabled()) return "off";
    const now = Date.now();
    if (!options.force) {
      if (now < (local.due.get(spec.name) ?? 0)) return "not_due";
      if (now < (await dueAt(spec.name))) return "not_due";
      if (spec.idleAfterMs) {
        const seen = await readJson<{ at?: number }>(seenName(spec.name));
        if (now - (seen?.at ?? 0) > spec.idleAfterMs) return "idle";
      }
    }
    const lease = await acquireLease(`job:${spec.name}`, spec.leaseMs);
    if (!lease) return "busy";
    try {
      // Someone may have finished a round between the check above and taking the lease.
      if (!options.force && Date.now() < (await dueAt(spec.name))) return "not_due";
      const started = Date.now();
      let next = spec.everyMs();
      let error: string | null = null;
      try {
        const asked = await spec.run(lease);
        if (typeof asked === "number" && Number.isFinite(asked)) next = asked;
      } catch (failure) {
        error = message(failure);
        next = Math.min(next, spec.retryMs);
        console.warn(`[jobs] ${spec.name} failed:`, error);
      }
      const finished = Date.now();
      const state: JobState = { lastRunAt: finished, nextDueAt: finished + Math.max(0, next), ok: error === null, error, ms: finished - started };
      local.due.set(spec.name, state.nextDueAt);
      await writeJson(stateName(spec.name), state).catch(() => undefined);
      return error === null ? "ran" : "failed";
    } finally {
      await lease.release();
    }
  } catch (error) {
    console.warn(`[jobs] ${spec.name} could not start:`, message(error));
    return "failed";
  }
}

/**
 * Lets work started by a request finish after the reply has gone: on Vercel the function is kept
 * alive for it (up to the route's maxDuration); elsewhere the promise simply runs on.
 */
export function inBackground(work: Promise<unknown>): void {
  const settled = work.catch((error) => console.warn("[background]", message(error)));
  try {
    waitUntil(settled);
  } catch {
    // Not inside a Vercel request: nothing to extend.
  }
}
