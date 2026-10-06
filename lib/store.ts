// Server state: small JSON documents by name, leases (locks with an expiry) and writes that only
// land while a lease is still held.
//
// Two backends, chosen by the environment:
//   - Upstash Redis when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are set, or the
//     KV_REST_API_URL / KV_REST_API_TOKEN pair that the Vercel Marketplace integration injects.
//     Every server instance sees the same state, which is what Vercel needs: it runs many short-lived
//     instances, and its file system is read-only apart from a per-instance /tmp.
//   - Otherwise JSON files in a gitignored directory (.data next to the app, SONGS_DATA_DIR to move
//     it), which is how this has always run on the Mac: one long-running server, one process.
//
// A name is a relative path such as "songs.json" or "coin-flip/deposits/<id>.json": the file under
// the data directory, or the Redis key with BAB_STORE_PREFIX ("bab:" by default) in front.

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Redis } from "@upstash/redis";

export type StoreBackend = "redis" | "fs";

/** True when running as a Vercel Function (Vercel sets VERCEL=1 in every deployment). */
export function onVercel(): boolean {
  return Boolean(process.env.VERCEL);
}

function redisEnv(): { url: string; token: string } | null {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL)?.trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN)?.trim();
  return url && token ? { url, token } : null;
}

const globalStore = globalThis as typeof globalThis & {
  __babRedis?: { url: string; redis: Redis };
  __babLeases?: Map<string, { token: string; expiresAt: number }>;
};

function redis(): Redis | null {
  const env = redisEnv();
  if (!env) return null;
  if (globalStore.__babRedis?.url !== env.url) {
    // Values go in and come out as the JSON strings written here, never re-parsed by the client.
    globalStore.__babRedis = { url: env.url, redis: new Redis({ url: env.url, token: env.token, automaticDeserialization: false }) };
  }
  return globalStore.__babRedis.redis;
}

export function storeBackend(): StoreBackend {
  return redisEnv() ? "redis" : "fs";
}

/**
 * Whether every server instance sees the same state: Redis, or files read by the one long-running
 * server on the Mac. Files on Vercel are not: each instance has its own /tmp and loses it.
 */
export function storeIsShared(): boolean {
  return storeBackend() === "redis" || !onVercel();
}

/**
 * How long a copy of stored state held in memory may be served before it is read again. Files
 * have a single writer (this process), so never; with Redis another instance may have written.
 */
export function reloadAfterMs(): number {
  return storeBackend() === "redis" ? 10_000 : Number.POSITIVE_INFINITY;
}

const prefix = () => process.env.BAB_STORE_PREFIX?.trim() || "bab:";
const redisKey = (name: string) => `${prefix()}${name}`;

export function dataDir(): string {
  if (process.env.SONGS_DATA_DIR) return process.env.SONGS_DATA_DIR;
  // The deployment's own directory is read-only on Vercel. /tmp is writable, but per instance.
  return onVercel() ? path.join(os.tmpdir(), "bab-data") : path.join(process.cwd(), ".data");
}

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

function filePath(name: string): string {
  if (!NAME.test(name)) throw new Error(`Invalid store name: ${name}`);
  return path.join(dataDir(), ...name.split("/"));
}

/** A store name made from arbitrary text (a transaction hash and log index, say). */
export function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 200);
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** Parsed JSON, or null when missing. Throws when the store cannot be read or holds bad JSON. */
export async function readJsonStrict<T>(name: string): Promise<T | null> {
  const client = redis();
  if (client) {
    const raw = await client.get<string>(redisKey(name));
    return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
  }
  try {
    return JSON.parse(await readFile(filePath(name), "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

/** Parsed JSON, or null if it is missing or unreadable. Never throws. */
export async function readJson<T>(name: string): Promise<T | null> {
  try {
    return await readJsonStrict<T>(name);
  } catch {
    return null;
  }
}

/** Several at once (one round trip with Redis), in the same order; null for each one missing. Throws on store errors. */
export async function readManyStrict<T>(names: string[]): Promise<(T | null)[]> {
  if (!names.length) return [];
  const client = redis();
  if (client) {
    const raw = await client.mget<(string | null)[]>(...names.map(redisKey));
    return raw.map((value) => (value === null || value === undefined ? null : (JSON.parse(value) as T)));
  }
  return Promise.all(names.map((name) => readJsonStrict<T>(name)));
}

/** When a document was last written, for cheap change checks; null when missing or unknown. */
export async function modifiedAt(name: string): Promise<number | null> {
  if (redis()) return null;
  try {
    return (await stat(filePath(name))).mtimeMs;
  } catch {
    return null;
  }
}

async function writeFileAtomic(name: string, value: unknown, mode: number): Promise<void> {
  const target = filePath(name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  // writeFile's mode is masked by umask and ignored for an existing file; make it explicit.
  await chmod(temp, mode);
  await rename(temp, target);
}

/** Replaces a document. Files are written atomically (temp file + rename), mode 600 by default. */
export async function writeJson(name: string, value: unknown, mode = 0o600): Promise<void> {
  const client = redis();
  if (client) {
    await client.set(redisKey(name), JSON.stringify(value));
    return;
  }
  await writeFileAtomic(name, value, mode);
}

// --- Leases ------------------------------------------------------------------------------------

export type Lease = {
  name: string;
  token: string;
  /** Epoch ms by this process's clock, counted from just before the lease was asked for, so never late. */
  expiresAt: number;
  /** Time left on the lease by this process's clock. */
  remainingMs(): number;
  /** Gives it up if it is still ours. Never throws. */
  release(): Promise<void>;
};

const leaseKey = (name: string) => redisKey(`lease:${name}`);
const localLeases = () => (globalStore.__babLeases ??= new Map());

/**
 * Takes the named lease for `ttlMs` unless someone else holds it (null then). With Redis this is
 * SET NX PX across every instance; with files it is a lock inside this process, which is the only
 * writer there is.
 */
export async function acquireLease(name: string, ttlMs: number): Promise<Lease | null> {
  const token = `t_${randomBytes(16).toString("hex")}`;
  const startedAt = Date.now();
  const client = redis();
  if (client) {
    const ok = await client.set(leaseKey(name), token, { nx: true, px: ttlMs });
    if (ok !== "OK") return null;
  } else {
    const held = localLeases().get(name);
    if (held && held.expiresAt > startedAt) return null;
    localLeases().set(name, { token, expiresAt: startedAt + ttlMs });
  }
  const expiresAt = startedAt + ttlMs;
  return {
    name,
    token,
    expiresAt,
    remainingMs: () => expiresAt - Date.now(),
    release: async () => {
      try {
        if (client) {
          await client.eval(`if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`, [leaseKey(name)], [token]);
        } else if (localLeases().get(name)?.token === token) {
          localLeases().delete(name);
        }
      } catch {
        // It expires on its own.
      }
    },
  };
}

export type LeasedWrite = {
  name: string;
  value: unknown;
  /** Write-once: the whole batch is refused if this document already exists. */
  once?: boolean;
};

export type LeasedWriteResult =
  | { ok: true }
  | { ok: false; reason: "lease_lost" }
  | { ok: false; reason: "exists"; existing: Record<string, unknown> };

// KEYS[1] is the lease, KEYS[2..n+1] the documents. ARGV[1] is the lease token, ARGV[2] the count,
// then a once flag and a value per document.
const LEASED_WRITE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return {'lease_lost'} end
local n = tonumber(ARGV[2])
local existing = {}
for i = 1, n do
  if ARGV[1 + 2 * i] == '1' then
    local value = redis.call('GET', KEYS[1 + i])
    if value then
      table.insert(existing, KEYS[1 + i])
      table.insert(existing, value)
    end
  end
end
if #existing > 0 then
  table.insert(existing, 1, 'exists')
  return existing
end
for i = 1, n do redis.call('SET', KEYS[1 + i], ARGV[2 + 2 * i]) end
return {'ok'}`;

/**
 * Writes every document only if `lease` is still held and none of the `once` documents exists yet,
 * as one atomic step with Redis. A holder whose lease ran out can therefore never overwrite what the
 * next holder wrote. With files the check is against this process's lease table, and the documents
 * are written in the order given.
 */
export async function writeWithLease(lease: Lease, writes: LeasedWrite[]): Promise<LeasedWriteResult> {
  const client = redis();
  if (client) {
    const keys = [leaseKey(lease.name), ...writes.map((write) => redisKey(write.name))];
    const args = [lease.token, String(writes.length), ...writes.flatMap((write) => [write.once ? "1" : "0", JSON.stringify(write.value)])];
    const reply = (await client.eval(LEASED_WRITE, keys, args)) as string[];
    if (reply[0] === "ok") return { ok: true };
    if (reply[0] === "exists") {
      const existing: Record<string, unknown> = {};
      for (let index = 1; index + 1 < reply.length; index += 2) existing[reply[index].slice(prefix().length)] = JSON.parse(reply[index + 1]);
      return { ok: false, reason: "exists", existing };
    }
    return { ok: false, reason: "lease_lost" };
  }

  const held = localLeases().get(lease.name);
  if (held?.token !== lease.token || held.expiresAt <= Date.now()) return { ok: false, reason: "lease_lost" };
  const existing: Record<string, unknown> = {};
  for (const write of writes) {
    if (!write.once) continue;
    const value = await readJsonStrict<unknown>(write.name);
    if (value !== null) existing[write.name] = value;
  }
  if (Object.keys(existing).length) return { ok: false, reason: "exists", existing };
  for (const write of writes) await writeFileAtomic(write.name, write.value, 0o600);
  return { ok: true };
}
