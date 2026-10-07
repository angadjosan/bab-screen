// Jarvis memory: SQLite via better-sqlite3 at .data/jarvis.db (JARVIS_DB_PATH overrides it; ":memory:" for tests).
// One owner: only the agent process opens this file.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../lib/songs-store";
import { TIME_ZONE } from "./config";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  slack_id TEXT PRIMARY KEY,
  name TEXT,
  interests TEXT NOT NULL DEFAULT '',
  running_jokes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS visitors (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  hints TEXT NOT NULL DEFAULT '',
  headline TEXT,
  summary TEXT,
  links TEXT NOT NULL DEFAULT '[]',
  sources TEXT NOT NULL DEFAULT '[]',
  image_url TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  brought_by TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS visitors_name ON visitors (name_key);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY,
  about TEXT NOT NULL,
  about_key TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',
  text TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_about ON memories (about_key);
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  who TEXT NOT NULL,
  who_id TEXT,
  status TEXT NOT NULL DEFAULT 'in',
  source TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  who TEXT,
  source TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  args TEXT,
  ok INTEGER NOT NULL,
  result TEXT
);
CREATE TABLE IF NOT EXISTS spend (
  day TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider, model)
);
`;

let db: Database.Database | null = null;

export function openDb(file = process.env.JARVIS_DB_PATH?.trim() || path.join(dataDir(), "jarvis.db")): Database.Database {
  if (db) return db;
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

const get = () => openDb();

/** Lower-case, accents and punctuation folded, for matching names typed or spoken differently. */
export function nameKey(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** YYYY-MM-DD in the club's zone. */
export function today(now = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// --- Spend -----------------------------------------------------------------------------------

export function addSpend(provider: "fireworks" | "exa", model: string, usd: number, tokensIn = 0, tokensOut = 0) {
  get()
    .prepare(`INSERT INTO spend (day, provider, model, usd, tokens_in, tokens_out, calls) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT (day, provider, model) DO UPDATE SET usd = usd + excluded.usd, tokens_in = tokens_in + excluded.tokens_in,
      tokens_out = tokens_out + excluded.tokens_out, calls = calls + 1`)
    .run(today(), provider, model, usd, tokensIn, tokensOut);
}

export function spentToday(): number {
  const row = get().prepare("SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day = ?").get(today()) as { usd: number };
  return row.usd;
}

// --- Log -------------------------------------------------------------------------------------

export type Who = { id: string | null; name: string | null; source: string };

export function logEvent(who: Who, kind: "tool" | "rule" | "turn" | "scheduler", name: string, args: unknown, ok: boolean, result: unknown) {
  try {
    get()
      .prepare("INSERT INTO events_log (at, who, source, kind, name, args, ok, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), who.name ?? who.id, who.source, kind, name, JSON.stringify(args ?? null).slice(0, 4_000), ok ? 1 : 0, JSON.stringify(result ?? null).slice(0, 4_000));
  } catch (error) {
    console.error("[jarvis] events_log write failed:", error);
  }
}

export function recentEvents(limit = 20) {
  return get().prepare("SELECT * FROM events_log ORDER BY id DESC LIMIT ?").all(limit);
}

// --- Members ---------------------------------------------------------------------------------

export type Member = { slack_id: string; name: string | null; interests: string; running_jokes: string };

export function upsertMember(slackId: string, name: string | null) {
  get()
    .prepare(`INSERT INTO members (slack_id, name, updated_at) VALUES (?, ?, ?)
      ON CONFLICT (slack_id) DO UPDATE SET name = COALESCE(excluded.name, name), updated_at = excluded.updated_at`)
    .run(slackId, name, Date.now());
}

export function getMember(slackId: string): Member | null {
  return (get().prepare("SELECT slack_id, name, interests, running_jokes FROM members WHERE slack_id = ?").get(slackId) as Member | undefined) ?? null;
}

export function findMemberByName(name: string): Member | null {
  const key = nameKey(name);
  if (!key) return null;
  const rows = get().prepare("SELECT slack_id, name, interests, running_jokes FROM members WHERE name IS NOT NULL").all() as Member[];
  return rows.find((row) => nameKey(row.name ?? "") === key) ?? rows.find((row) => nameKey(row.name ?? "").split(" ")[0] === key) ?? null;
}

/** Appends to a member's interests or running jokes (kept as "; "-separated text). */
export function appendMemberField(slackId: string, field: "interests" | "running_jokes", text: string) {
  const member = getMember(slackId);
  if (!member) return;
  const current = member[field].split(/;\s*/).filter(Boolean);
  if (!current.some((item) => item.toLowerCase() === text.toLowerCase())) current.push(text);
  get().prepare(`UPDATE members SET ${field} = ?, updated_at = ? WHERE slack_id = ?`).run(current.slice(-20).join("; "), Date.now(), slackId);
}

// --- Memories --------------------------------------------------------------------------------

export type MemoryRow = { id: number; about: string; kind: string; text: string; created_by: string | null; created_at: number };

export function addMemory(about: string, kind: string, text: string, createdBy: string | null): number {
  const result = get()
    .prepare("INSERT INTO memories (about, about_key, kind, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(about, nameKey(about), kind, text, createdBy, Date.now());
  return Number(result.lastInsertRowid);
}

/** Memories about any of `names` (exact or first-name match), plus any whose text contains `query`. */
export function findMemories(options: { about?: string[]; query?: string; limit?: number }): MemoryRow[] {
  const keys = [...new Set((options.about ?? []).map(nameKey).filter(Boolean))];
  const clauses: string[] = [];
  const params: unknown[] = [];
  for (const key of keys) {
    clauses.push("about_key = ? OR about_key LIKE ?");
    params.push(key, `${key} %`);
  }
  if (options.query?.trim()) {
    clauses.push("text LIKE ? OR about LIKE ?");
    params.push(`%${options.query.trim()}%`, `%${options.query.trim()}%`);
  }
  if (!clauses.length) return [];
  return get()
    .prepare(`SELECT id, about, kind, text, created_by, created_at FROM memories WHERE ${clauses.map((clause) => `(${clause})`).join(" OR ")} ORDER BY id DESC LIMIT ?`)
    .all(...params, options.limit ?? 12) as MemoryRow[];
}

/** Every distinct `about`, so the prompt builder can spot names in a message. */
export function memorySubjects(): string[] {
  return (get().prepare("SELECT DISTINCT about FROM memories ORDER BY id DESC LIMIT 500").all() as { about: string }[]).map((row) => row.about);
}

// --- Check-ins -------------------------------------------------------------------------------

export function addCheckin(who: string, whoId: string | null, status: "in" | "out", source: string) {
  get().prepare("INSERT INTO checkins (who, who_id, status, source, at) VALUES (?, ?, ?, ?, ?)").run(who, whoId, status, source, Date.now());
}

/** Who is in now: latest check-in per person today, if it says "in". */
export function checkedInToday(now = Date.now()): string[] {
  const rows = get().prepare("SELECT who, status, at FROM checkins WHERE at > ? ORDER BY at ASC").all(now - 18 * 3_600_000) as { who: string; status: string; at: number }[];
  const latest = new Map<string, string>();
  for (const row of rows) if (today(row.at) === today(now)) latest.set(row.who, row.status);
  return [...latest].filter(([, status]) => status === "in").map(([who]) => who);
}

// --- Visitors --------------------------------------------------------------------------------

export type VisitorRow = {
  id: number;
  name: string;
  hints: string;
  headline: string | null;
  summary: string | null;
  links: string;
  sources: string;
  image_url: string | null;
  confidence: number;
  brought_by: string | null;
  last_seen: number;
};

export function findVisitors(name: string, limit = 5): VisitorRow[] {
  const key = nameKey(name);
  if (!key) return [];
  return get().prepare("SELECT * FROM visitors WHERE name_key = ? ORDER BY last_seen DESC LIMIT ?").all(key, limit) as VisitorRow[];
}

export function recentVisitors(sinceMs: number, limit = 10): VisitorRow[] {
  return get().prepare("SELECT * FROM visitors WHERE last_seen > ? ORDER BY last_seen DESC LIMIT ?").all(sinceMs, limit) as VisitorRow[];
}

export function saveVisitor(visitor: {
  name: string;
  hints: string;
  headline: string | null;
  summary: string | null;
  links: { label: string; url: string }[];
  sources: string[];
  imageUrl: string | null;
  confidence: number;
  broughtBy: string | null;
}): number {
  const now = Date.now();
  const key = nameKey(visitor.name);
  const existing = get().prepare("SELECT id FROM visitors WHERE name_key = ? AND COALESCE(headline, '') = COALESCE(?, '')").get(key, visitor.headline) as { id: number } | undefined;
  if (existing) {
    get()
      .prepare(`UPDATE visitors SET name = ?, hints = ?, summary = ?, links = ?, sources = ?, image_url = ?, confidence = ?, brought_by = COALESCE(?, brought_by), last_seen = ? WHERE id = ?`)
      .run(visitor.name, visitor.hints, visitor.summary, JSON.stringify(visitor.links), JSON.stringify(visitor.sources), visitor.imageUrl, visitor.confidence, visitor.broughtBy, now, existing.id);
    return existing.id;
  }
  const result = get()
    .prepare(`INSERT INTO visitors (name, name_key, hints, headline, summary, links, sources, image_url, confidence, brought_by, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(visitor.name, key, visitor.hints, visitor.headline, visitor.summary, JSON.stringify(visitor.links), JSON.stringify(visitor.sources), visitor.imageUrl, visitor.confidence, visitor.broughtBy, now, now);
  return Number(result.lastInsertRowid);
}

export function touchVisitor(id: number) {
  get().prepare("UPDATE visitors SET last_seen = ? WHERE id = ?").run(Date.now(), id);
}
