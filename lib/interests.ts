// Member interests for the feed: what the people in the clubroom said they care about, read from
// Jarvis's memory (.data/jarvis.db) so the curation prompt (lib/feed-agent.ts) can lean toward it.
//
// The agent owns that database and is its only writer. This side opens it read-only, once per
// feed refresh, and closes it again; WAL mode lets it read while the agent writes. Reading the
// database directly (rather than a snapshot file the agent would export) means every way a
// check-in or an interest gets recorded (Slack, voice, a rule, a tool) counts at once, with no
// extra writer. A missing file, a missing table, a locked or corrupt database all mean "no
// interests", and the feed then behaves exactly as it does without Jarvis.
//
// Who counts: anyone whose latest check-in today (club time) says "in". When nobody is in, or
// nobody who is in has told Jarvis anything, every member's interests are used instead.
//
// Interests are text typed by members, so they are untrusted: each is reduced to one short line
// of letters, digits and a little punctuation, and the list is capped in count and length. The
// prompt carries them as data in their own block, never as instructions.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { tidy } from "./feed-parse";
import { dataDir } from "./songs-store";

/** Same zone the agent uses for "today" (agent/config.ts). */
const TIME_ZONE = "America/Los_Angeles";
/** A check-in older than this never counts, whatever the date says. */
const CHECKIN_WINDOW_MS = 18 * 3_600_000;
export const MAX_INTERESTS = 20;
export const INTEREST_MAX_CHARS = 60;

export type FeedInterests = {
  /** Whose interests these are: the people checked in now, or every member. */
  scope: "in_office" | "members";
  /** How many people the list was drawn from. */
  people: number;
  /** Most-mentioned first, deduplicated, already cleaned and capped. */
  interests: string[];
};

/** Lower-case, accents and punctuation folded: the agent's nameKey() (agent/db.ts). */
function nameKey(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function day(at: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** One interest as it may appear in the prompt, or null. Splits nothing; see splitInterests. */
export function cleanInterest(text: string): string | null {
  const plain = tidy(text)
    .replace(/[^\p{L}\p{N} .,+#&'/-]/gu, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,'/&+-]+|[\s.,'/&+-]+$/g, "")
    .trim();
  if (!plain || !/[\p{L}\p{N}]/u.test(plain)) return null;
  return plain.length > INTEREST_MAX_CHARS ? plain.slice(0, INTEREST_MAX_CHARS).replace(/\s+\S*$/, "") || plain.slice(0, INTEREST_MAX_CHARS) : plain;
}

/** A stored entry may hold several ("zk; MEV" on the member row, "zk, MEV" in a memory). */
export function splitInterests(text: string): string[] {
  return text.split(/[;,\n]+/).map(cleanInterest).filter((item): item is string => item !== null);
}

type Person = { key: string; id: string | null };
type Row = { key: string; id: string | null; text: string; at: number };

/**
 * Ranks and caps a list of interests: most people first, then most recent, case-insensitively
 * deduplicated. Pure; exported for the tests.
 */
export function rankInterests(rows: Row[], max = MAX_INTERESTS): string[] {
  const tally = new Map<string, { text: string; people: Set<string>; at: number }>();
  for (const row of rows) {
    for (const text of splitInterests(row.text)) {
      const key = text.toLowerCase();
      const entry = tally.get(key) ?? { text, people: new Set<string>(), at: 0 };
      entry.people.add(row.id ?? row.key);
      entry.at = Math.max(entry.at, row.at);
      tally.set(key, entry);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.people.size - a.people.size || b.at - a.at)
    .slice(0, max)
    .map((entry) => entry.text);
}

function dbFile(): string | null {
  const file = process.env.JARVIS_DB_PATH?.trim() || path.join(dataDir(), "jarvis.db");
  return file === ":memory:" ? null : file;
}

/** Every table query runs in the system SQLite process, keeping its native addon out of Next dev. */
function rowsOf<T>(file: string, sql: string): T[] {
  try {
    const output = execFileSync("/usr/bin/sqlite3", ["-readonly", "-json", file, sql], {
      encoding: "utf8",
      timeout: 1_000,
      maxBuffer: 512 * 1024,
    });
    const rows: unknown = JSON.parse(output || "[]");
    return Array.isArray(rows) ? rows as T[] : [];
  } catch {
    return [];
  }
}

/**
 * The interests the feed should lean toward right now, or null when there are none (or Jarvis's
 * database is missing or unreadable). Never throws.
 */
export function readInterests(now = Date.now()): FeedInterests | null {
  const file = dbFile();
  if (!file) return null;
  try {
    const checkins = rowsOf<{ who: string; who_id: string | null; status: string; at: number }>(
      file,
      `SELECT who, who_id, status, at FROM checkins WHERE at > ${Math.trunc(now - CHECKIN_WINDOW_MS)} ORDER BY at ASC`,
    );
    const latest = new Map<string, { person: Person; status: string }>();
    for (const row of checkins) {
      if (day(row.at) !== day(now)) continue;
      const key = nameKey(row.who);
      if (key) latest.set(key, { person: { key, id: row.who_id }, status: row.status });
    }
    const present = [...latest.values()].filter((entry) => entry.status === "in").map((entry) => entry.person);

    const memories = rowsOf<{ about_key: string; text: string; created_at: number }>(
      file,
      "SELECT about_key, text, created_at FROM memories WHERE kind = 'interest' ORDER BY id DESC LIMIT 2000",
    ).map((row): Row => ({ key: row.about_key, id: null, text: row.text, at: row.created_at }));
    const members = rowsOf<{ slack_id: string; name: string | null; interests: string; updated_at: number }>(
      file,
      "SELECT slack_id, name, interests, updated_at FROM members WHERE interests != ''",
    ).map((row): Row => ({ key: nameKey(row.name ?? ""), id: row.slack_id, text: row.interests, at: row.updated_at }));
    const all = [...memories, ...members];

    // A memory's subject may be a full name or just a first name, as in findMemories().
    const matches = (row: Row, person: Person) =>
      (row.id !== null && row.id === person.id) ||
      (row.key !== "" && (row.key === person.key || row.key.split(" ")[0] === person.key || person.key.split(" ")[0] === row.key));
    const inOffice = all.filter((row) => present.some((person) => matches(row, person)));
    // Count people by name so a memory row and a member row about the same person are one.
    const peopleIn = (rows: Row[]) => new Set(rows.map((row) => row.key || row.id)).size;

    if (inOffice.length) {
      const interests = rankInterests(inOffice);
      if (interests.length) return { scope: "in_office", people: peopleIn(inOffice), interests };
    }
    const interests = rankInterests(all);
    return interests.length ? { scope: "members", people: peopleIn(all), interests } : null;
  } catch {
    return null;
  }
}
