// Game state in the agent's SQLite (.data/jarvis.db, see agent/db.ts): one row per game, the whole game as JSON.
// At most one active game of each kind; finished games stay as history.

import { openDb } from "../db";

export type GameKind = "poker" | "mafia";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS games_active ON games (kind, active);
`;

let ready: unknown = null;

function db() {
  const handle = openDb();
  // Re-run when the database was closed and opened again (tests).
  if (ready !== handle) {
    handle.exec(SCHEMA);
    ready = handle;
  }
  return handle;
}

/** The active game of `kind`, or null. */
export function loadActive<T>(kind: GameKind): { id: number; state: T } | null {
  const row = db().prepare("SELECT id, state FROM games WHERE kind = ? AND active = 1 ORDER BY id DESC LIMIT 1").get(kind) as { id: number; state: string } | undefined;
  if (!row) return null;
  try {
    return { id: row.id, state: JSON.parse(row.state) as T };
  } catch {
    return null;
  }
}

/** Starts a new game of `kind`; any active one is ended first. Returns its id. */
export function createGame(kind: GameKind, state: unknown): number {
  const now = Date.now();
  const handle = db();
  handle.prepare("UPDATE games SET active = 0, updated_at = ? WHERE kind = ? AND active = 1").run(now, kind);
  return Number(handle.prepare("INSERT INTO games (kind, active, state, created_at, updated_at) VALUES (?, 1, ?, ?, ?)").run(kind, JSON.stringify(state), now, now).lastInsertRowid);
}

export function saveGame(id: number, state: unknown, active = true) {
  db().prepare("UPDATE games SET state = ?, active = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(state), active ? 1 : 0, Date.now(), id);
}
