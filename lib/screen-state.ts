// What the TV shows, as server state: which widget is in each slot (app/widgets/registry.ts), the overlays on top
// (a banner, a person card), the pinned Slack thread, the leaderboard and the game running (Mafia or poker). The agent changes it with
// POST /api/screen; every page on /api/screen/stream is sent the whole state on every change.
//
// Stored in .data/screen.json. The Next process is the only writer: the agent never touches the file, it asks.

import { randomUUID } from "node:crypto";
import {
  PRESET_LAYOUTS,
  SLOTS,
  WIDGETS,
  fits,
  isPreset,
  isSlot,
  isWidgetId,
  type Layout,
  type Preset,
} from "../app/widgets/registry";
import { readJson, writeJson } from "./songs-store";

const STATE_FILE = "screen.json";
const BANNER_TTL_S = 20;
const PERSON_TTL_S = 30;
/** No overlay stays longer than this, whatever the request asks. */
const MAX_TTL_S = 60 * 60;

const MAX_BANNER = 280;
const MAX_NAME = 80;
const MAX_HEADLINE = 140;
const MAX_SUMMARY = 600;
const MAX_LINKS = 4;
const MAX_LABEL = 40;
const MAX_URL = 500;
const MAX_THREAD_TEXT = 1_500;
const MAX_REPLIES = 12;
const MAX_REPLY_TEXT = 500;
const MAX_AUTHOR = 80;
const MAX_TITLE = 80;
const MAX_ROWS = 20;
const MAX_GAME_PLAYERS = 20;
const MAX_GAME_LINE = 200;
const MAX_GAME_DETAIL = 400;
/** Poker amounts are play money; anything past this is not a number anyone typed on purpose. */
const MAX_GAME_AMOUNT = 100_000_000;
/** A phase clock further out than this is a mistake (Mafia phases are minutes). */
const MAX_PHASE_MS = 60 * 60_000;

export type PersonCard = {
  name: string;
  headline: string | null;
  summary: string | null;
  links: { label: string; url: string }[];
  imageUrl: string | null;
};

/** Times are epoch ms on the server's clock. */
export type Overlay =
  | { id: string; kind: "banner"; text: string; createdAt: number; expiresAt: number }
  | { id: string; kind: "person"; card: PersonCard; createdAt: number; expiresAt: number };

export type PinnedThread = {
  channel: string;
  ts: string;
  author: string | null;
  text: string;
  replies: { author: string; text: string }[];
  permalink: string | null;
};

/** Highest score first. */
export type Leaderboard = { title: string; rows: { name: string; score: number }[] };

export const MAFIA_ROLES = ["mafia", "doctor", "detective", "villager"] as const;
export type MafiaRole = (typeof MAFIA_ROLES)[number];

/**
 * A Mafia game as the TV shows it (the agent runs it: agent/games/mafia-service.ts). `endsAt` is when the phase
 * ends, epoch ms on this machine's clock (the agent and the TV share it). A role is given only for the dead, and
 * for everyone once the game is over.
 */
export type MafiaScreen = {
  kind: "mafia";
  phase: "night" | "day" | "over";
  round: number;
  endsAt: number | null;
  headline: string;
  detail: string | null;
  players: { name: string; alive: boolean; role: MafiaRole | null; votes: number }[];
  winner: "town" | "mafia" | null;
};

/** The poker table (agent/games/poker.ts), amounts in whole units. `net` and `stack` are null until counted. */
export type PokerScreen = {
  kind: "poker";
  title: string;
  status: "live" | "settled";
  players: { name: string; buyIn: number; stack: number | null; net: number | null; out: boolean }[];
  payouts: { from: string; to: string; amount: number }[];
  note: string | null;
};

export type GameScreen = MafiaScreen | PokerScreen;

export type ScreenState = {
  /** Goes up by one on every change. */
  version: number;
  updatedAt: string;
  /** The preset last applied. show_widget changes slots without changing this, so the two can differ. */
  preset: Preset;
  slots: Layout;
  /** At most one of each kind; a new one replaces the old. Expired ones are pruned (and pushed) on time. */
  overlays: Overlay[];
  pinnedThread: PinnedThread | null;
  leaderboard: Leaderboard | null;
  game: GameScreen | null;
};

export type ScreenOp =
  | { op: "set_preset"; preset: string }
  | { op: "show_widget"; slot: string; widget: string }
  | { op: "banner"; text: string; ttlSeconds?: number }
  | { op: "person"; card: unknown; ttlSeconds?: number }
  | { op: "clear_overlays" }
  | { op: "pin_thread"; thread: unknown }
  | { op: "unpin_thread" }
  | { op: "leaderboard"; title: string; rows: unknown }
  | { op: "game"; game: unknown }
  | { op: "clear_game" };

export type OpResult = { ok: true; state: ScreenState } | { ok: false; error: string };

type Listener = (state: ScreenState) => void;

// On globalThis so every copy of this module (route bundles, dev-mode reloads) shares one state and one list of
// open streams: the POST route and the stream route must see the same object.
type Runtime = {
  state: ScreenState | null;
  loading: Promise<ScreenState> | null;
  listeners: Set<Listener>;
  /** Fires when the next overlay expires. */
  expiry: NodeJS.Timeout | null;
  /** Writes are chained so two changes in a row can never land out of order. */
  saving: Promise<void>;
};

const globalStore = globalThis as typeof globalThis & { __babScreen?: Runtime };
const runtime: Runtime = (globalStore.__babScreen ??= { state: null, loading: null, listeners: new Set(), expiry: null, saving: Promise.resolve() });

function initialState(): ScreenState {
  return {
    version: 0,
    updatedAt: new Date().toISOString(),
    preset: "default",
    slots: { ...PRESET_LAYOUTS.default },
    overlays: [],
    pinnedThread: null,
    leaderboard: null,
    game: null,
  };
}

// --- Checks ----------------------------------------------------------------------------------

class Invalid extends Error {}

const fail = (message: string): never => {
  throw new Invalid(message);
};

/** A trimmed, non-empty string of at most `max` characters, or an error naming the field. */
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") return fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) return fail(`${field} must not be empty`);
  if (trimmed.length > max) return fail(`${field} is longer than ${max} characters`);
  return trimmed;
}

/** Left out, null or blank all mean "not given". */
const absent = (value: unknown) => value === undefined || value === null || (typeof value === "string" && !value.trim());
const optionalText = (value: unknown, field: string, max: number) => (absent(value) ? null : text(value, field, max));

/** Only http(s) links: anything else could not be shown (or is a script). */
function link(value: unknown, field: string): string {
  const raw = text(value, field, MAX_URL);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail(`${field} is not a URL`);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return fail(`${field} must be an http(s) URL`);
  return url.toString();
}

const optionalLink = (value: unknown, field: string) => (absent(value) ? null : link(value, field));

function list(value: unknown, field: string, max: number): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return fail(`${field} must be an array`);
  if (value.length > max) return fail(`${field} has more than ${max} entries`);
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function ttl(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fail("ttlSeconds must be a positive number");
  if (value > MAX_TTL_S) return fail(`ttlSeconds must be at most ${MAX_TTL_S}`);
  return value;
}

function personCard(value: unknown): PersonCard {
  const card = object(value, "card");
  return {
    name: text(card.name, "card.name", MAX_NAME),
    headline: optionalText(card.headline, "card.headline", MAX_HEADLINE),
    summary: optionalText(card.summary, "card.summary", MAX_SUMMARY),
    links: list(card.links, "card.links", MAX_LINKS).map((entry, i) => {
      const item = object(entry, `card.links[${i}]`);
      return { label: text(item.label, `card.links[${i}].label`, MAX_LABEL), url: link(item.url, `card.links[${i}].url`) };
    }),
    imageUrl: optionalLink(card.imageUrl, "card.imageUrl"),
  };
}

function pinnedThread(value: unknown): PinnedThread {
  const thread = object(value, "thread");
  const ts = text(thread.ts, "thread.ts", 40);
  if (!/^\d+\.\d+$/.test(ts)) fail("thread.ts must be a Slack timestamp like 1700000000.000100");
  return {
    channel: text(thread.channel, "thread.channel", 40),
    ts,
    author: optionalText(thread.author, "thread.author", MAX_AUTHOR),
    text: text(thread.text, "thread.text", MAX_THREAD_TEXT),
    replies: list(thread.replies, "thread.replies", MAX_REPLIES).map((entry, i) => {
      const reply = object(entry, `thread.replies[${i}]`);
      return { author: text(reply.author, `thread.replies[${i}].author`, MAX_AUTHOR), text: text(reply.text, `thread.replies[${i}].text`, MAX_REPLY_TEXT) };
    }),
    permalink: optionalLink(thread.permalink, "thread.permalink"),
  };
}

function leaderboard(title: unknown, rows: unknown): Leaderboard | null {
  const name = text(title, "title", MAX_TITLE);
  if (!Array.isArray(rows)) return fail("rows must be an array");
  const parsed = list(rows, "rows", MAX_ROWS).map((entry, i) => {
    const row = object(entry, `rows[${i}]`);
    const score = row.score;
    if (typeof score !== "number" || !Number.isFinite(score)) fail(`rows[${i}].score must be a number`);
    return { name: text(row.name, `rows[${i}].name`, MAX_NAME), score: score as number };
  });
  // No rows: the leaderboard is taken down, and its slot shows what the default puts there.
  if (!parsed.length) return null;
  return { title: name, rows: parsed.sort((a, b) => b.score - a.score) };
}

function amount(value: unknown, field: string, options: { nullable?: boolean; signed?: boolean } = {}): number | null {
  if (value === null && options.nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return fail(`${field} must be a number`);
  if (!options.signed && value < 0) return fail(`${field} must not be negative`);
  if (Math.abs(value) > MAX_GAME_AMOUNT) return fail(`${field} must be at most ${MAX_GAME_AMOUNT}`);
  return Math.round(value * 100) / 100;
}

function count(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) return fail(`${field} must be a whole number from 0 to ${max}`);
  return value;
}

function oneOf<T extends string>(value: unknown, field: string, values: readonly T[]): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) return fail(`${field} must be one of ${values.join(", ")}`);
  return value as T;
}

function flag(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") return fail(`${field} must be true or false`);
  return value;
}

function gameScreen(value: unknown, now: number): GameScreen {
  const game = object(value, "game");
  if (game.kind === "mafia") {
    const phase = oneOf(game.phase, "game.phase", ["night", "day", "over"] as const);
    let endsAt: number | null = null;
    if (game.endsAt !== null && game.endsAt !== undefined) {
      if (typeof game.endsAt !== "number" || !Number.isFinite(game.endsAt)) return fail("game.endsAt must be epoch ms or null");
      if (game.endsAt > now + MAX_PHASE_MS) return fail("game.endsAt is more than an hour away");
      endsAt = game.endsAt;
    }
    const players = list(game.players, "game.players", MAX_GAME_PLAYERS).map((entry, i) => {
      const player = object(entry, `game.players[${i}]`);
      return {
        name: text(player.name, `game.players[${i}].name`, MAX_NAME),
        alive: flag(player.alive, `game.players[${i}].alive`),
        role: player.role === null || player.role === undefined ? null : oneOf(player.role, `game.players[${i}].role`, MAFIA_ROLES),
        votes: count(player.votes ?? 0, `game.players[${i}].votes`, MAX_GAME_PLAYERS),
      };
    });
    if (!players.length) return fail("game.players must not be empty");
    return {
      kind: "mafia",
      phase,
      round: count(game.round, "game.round", 99),
      endsAt: phase === "over" ? null : endsAt,
      headline: text(game.headline, "game.headline", MAX_GAME_LINE),
      detail: optionalText(game.detail, "game.detail", MAX_GAME_DETAIL),
      players,
      winner: game.winner === null || game.winner === undefined ? null : oneOf(game.winner, "game.winner", ["town", "mafia"] as const),
    };
  }
  if (game.kind === "poker") {
    return {
      kind: "poker",
      title: text(game.title, "game.title", MAX_TITLE),
      status: oneOf(game.status, "game.status", ["live", "settled"] as const),
      players: list(game.players, "game.players", MAX_GAME_PLAYERS).map((entry, i) => {
        const player = object(entry, `game.players[${i}]`);
        return {
          name: text(player.name, `game.players[${i}].name`, MAX_NAME),
          buyIn: amount(player.buyIn, `game.players[${i}].buyIn`) as number,
          stack: amount(player.stack ?? null, `game.players[${i}].stack`, { nullable: true }),
          net: amount(player.net ?? null, `game.players[${i}].net`, { nullable: true, signed: true }),
          out: player.out === undefined ? false : flag(player.out, `game.players[${i}].out`),
        };
      }),
      payouts: list(game.payouts, "game.payouts", MAX_GAME_PLAYERS).map((entry, i) => {
        const payout = object(entry, `game.payouts[${i}]`);
        const value = amount(payout.amount, `game.payouts[${i}].amount`) as number;
        if (value <= 0) fail(`game.payouts[${i}].amount must be positive`);
        return { from: text(payout.from, `game.payouts[${i}].from`, MAX_NAME), to: text(payout.to, `game.payouts[${i}].to`, MAX_NAME), amount: value };
      }),
      note: optionalText(game.note, "game.note", MAX_GAME_LINE),
    };
  }
  return fail("game.kind must be mafia or poker");
}

// --- State -----------------------------------------------------------------------------------

// Everything saved past the layout is checked again as if it were a new request; anything that no longer passes is dropped.
function keep<T>(make: () => T): T | null {
  try {
    return make();
  } catch {
    return null;
  }
}

function reviveSlots(saved: Partial<ScreenState>, state: ScreenState) {
  for (const slot of SLOTS) {
    const widget = saved.slots?.[slot];
    if (isWidgetId(widget) && fits(widget, slot)) state.slots[slot] = widget;
  }
}

function reviveOverlay(overlay: Overlay, now: number): Overlay | null {
  if (!overlay || typeof overlay.expiresAt !== "number" || overlay.expiresAt <= now) return null;
  const base = { id: String(overlay.id ?? randomUUID()), createdAt: Number(overlay.createdAt) || now, expiresAt: overlay.expiresAt };
  if (overlay.kind === "banner") {
    const banner = keep(() => text(overlay.text, "text", MAX_BANNER));
    return banner ? { ...base, kind: "banner", text: banner } : null;
  }
  if (overlay.kind === "person") {
    const card = keep(() => personCard(overlay.card));
    return card ? { ...base, kind: "person", card } : null;
  }
  return null;
}

function reviveOverlays(saved: Partial<ScreenState>, now: number): Overlay[] {
  const overlays = Array.isArray(saved.overlays) ? saved.overlays : [];
  return overlays.map((overlay) => reviveOverlay(overlay, now)).filter((overlay): overlay is Overlay => overlay !== null);
}

/** A state read from the file, kept only where it still makes sense against the registry. */
function revive(saved: Partial<ScreenState> | null): ScreenState {
  const state = initialState();
  if (!saved || typeof saved !== "object") return state;
  if (typeof saved.version === "number" && Number.isFinite(saved.version)) state.version = saved.version;
  if (isPreset(saved.preset)) state.preset = saved.preset;
  reviveSlots(saved, state);
  const now = Date.now();
  state.overlays = reviveOverlays(saved, now);
  if (saved.pinnedThread) state.pinnedThread = keep(() => pinnedThread(saved.pinnedThread));
  if (saved.leaderboard) state.leaderboard = keep(() => leaderboard(saved.leaderboard?.title, saved.leaderboard?.rows));
  // A saved clock may have run out while nothing was running; the agent sends the next phase when it is back.
  if (saved.game) state.game = keep(() => gameScreen(saved.game, now));
  return state;
}

async function load(): Promise<ScreenState> {
  if (runtime.state) return runtime.state;
  runtime.loading ??= readJson<Partial<ScreenState>>(STATE_FILE).then((saved) => {
    runtime.state ??= revive(saved);
    scheduleExpiry();
    return runtime.state;
  });
  return runtime.loading;
}

/** Records a change: new version, saved to disk, sent to every open stream, expiry timer moved. */
function commit(next: ScreenState): ScreenState {
  next.version = (runtime.state?.version ?? 0) + 1;
  next.updatedAt = new Date().toISOString();
  runtime.state = next;
  runtime.saving = runtime.saving
    .then(() => writeJson(STATE_FILE, next))
    .catch((error) => console.error("[screen] could not save .data/screen.json:", error));
  scheduleExpiry();
  for (const listener of runtime.listeners) {
    try {
      listener(next);
    } catch {
      // A stream that broke mid-send is cleaned up by its own abort handler.
    }
  }
  return next;
}

/** One timer, for the overlay that expires first. When it fires the overlay is pruned and every screen told. */
function scheduleExpiry() {
  if (runtime.expiry) clearTimeout(runtime.expiry);
  runtime.expiry = null;
  const state = runtime.state;
  if (!state?.overlays.length) return;
  const first = Math.min(...state.overlays.map((overlay) => overlay.expiresAt));
  runtime.expiry = setTimeout(() => {
    runtime.expiry = null;
    const current = runtime.state;
    if (!current) return;
    const now = Date.now();
    const live = current.overlays.filter((overlay) => overlay.expiresAt > now);
    if (live.length !== current.overlays.length) commit({ ...current, overlays: live });
    else scheduleExpiry();
  }, Math.max(0, first - Date.now()) + 50);
  runtime.expiry.unref?.();
}

/** The current state, with expired overlays left out. */
export async function getScreenState(): Promise<ScreenState> {
  const state = await load();
  const now = Date.now();
  return state.overlays.some((overlay) => overlay.expiresAt <= now) ? { ...state, overlays: state.overlays.filter((overlay) => overlay.expiresAt > now) } : state;
}

/** Called with the state on every change until the returned function is called. */
export function subscribeScreen(listener: Listener): () => void {
  runtime.listeners.add(listener);
  return () => {
    runtime.listeners.delete(listener);
  };
}

type OpHandler = (body: Record<string, unknown>, state: ScreenState, now: number) => ScreenState;

function setPreset(body: Record<string, unknown>, state: ScreenState): ScreenState {
  if (!isPreset(body.preset)) return fail(`unknown preset (one of: ${Object.keys(PRESET_LAYOUTS).join(", ")})`);
  return { ...state, preset: body.preset, slots: { ...PRESET_LAYOUTS[body.preset] } };
}

function showWidget(body: Record<string, unknown>, state: ScreenState): ScreenState {
  if (!isSlot(body.slot)) return fail(`unknown slot (one of: ${SLOTS.join(", ")})`);
  if (!isWidgetId(body.widget)) return fail(`unknown widget (one of: ${Object.keys(WIDGETS).join(", ")})`);
  if (!fits(body.widget, body.slot)) return fail(`${body.widget} does not fit ${body.slot} (it goes in: ${WIDGETS[body.widget].fits.join(", ")})`);
  return { ...state, slots: { ...state.slots, [body.slot]: body.widget } };
}

function showBanner(body: Record<string, unknown>, state: ScreenState, now: number): ScreenState {
  const banner = text(body.text, "text", MAX_BANNER);
  const expiresAt = now + ttl(body.ttlSeconds, BANNER_TTL_S) * 1000;
  const overlays = state.overlays.filter((overlay) => overlay.kind !== "banner");
  return { ...state, overlays: [...overlays, { id: randomUUID(), kind: "banner", text: banner, createdAt: now, expiresAt }] };
}

function showPerson(body: Record<string, unknown>, state: ScreenState, now: number): ScreenState {
  const card = personCard(body.card);
  const expiresAt = now + ttl(body.ttlSeconds, PERSON_TTL_S) * 1000;
  const overlays = state.overlays.filter((overlay) => overlay.kind !== "person");
  return { ...state, overlays: [...overlays, { id: randomUUID(), kind: "person", card, createdAt: now, expiresAt }] };
}

const OP_HANDLERS: Record<ScreenOp["op"], OpHandler> = {
  set_preset: setPreset,
  show_widget: showWidget,
  banner: showBanner,
  person: showPerson,
  clear_overlays: (_body, state) => ({ ...state, overlays: [] }),
  pin_thread: (body, state) => ({ ...state, pinnedThread: pinnedThread(body.thread) }),
  unpin_thread: (_body, state) => ({ ...state, pinnedThread: null }),
  leaderboard: (body, state) => ({ ...state, leaderboard: leaderboard(body.title, body.rows) }),
  game: (body, state, now) => ({ ...state, game: gameScreen(body.game, now) }),
  clear_game: (_body, state) => ({ ...state, game: null }),
};

function opHandler(op: unknown): OpHandler {
  if (typeof op === "string" && Object.hasOwn(OP_HANDLERS, op)) return OP_HANDLERS[op as ScreenOp["op"]];
  return fail("unknown op (one of: set_preset, show_widget, banner, person, clear_overlays, pin_thread, unpin_thread, leaderboard, game, clear_game)");
}

/** Checks one op from POST /api/screen and applies it. Anything malformed changes nothing and says why. */
export async function applyScreenOp(raw: unknown): Promise<OpResult> {
  const state = await getScreenState();
  const now = Date.now();
  let next: ScreenState;
  try {
    const body = object(raw, "body");
    next = opHandler(body.op)(body, state, now);
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, state: commit(next) };
}
