// Poker tracker: buy-ins and rebuys, stack counts, cash-outs and who pays whom at the end. Play money only: this
// records numbers people type, it never moves anything (the coin-flip wallet is not in the agent's env at all).
//
// The rules (pure, tested in agent/selftest.ts) work in whole cents so payouts add up exactly. The service below
// keeps the one active game in SQLite (agent/games/store.ts) and puts the table on the TV (the `game` widget).

import { nameKey } from "../db";
import { ensureWidget, pushScreen, type GameScreen } from "../screen";
import { createGame, loadActive, saveGame } from "./store";

export type PokerPlayer = { name: string; buyIns: number[]; stack: number | null; cashedOut: boolean };
export type PokerGame = { title: string; startedAt: number; players: PokerPlayer[]; settled: boolean; payouts: Transfer[] | null };
export type Transfer = { from: string; to: string; amount: number };

const MAX_PLAYERS = 20;
/** One buy-in, rebuy or stack: at most this many units (play money; anything bigger is a typo). */
export const MAX_AMOUNT = 1_000_000;

export class PokerError extends Error {}

export const toCents = (amount: number) => Math.round(amount * 100);
export const formatAmount = (cents: number) => {
  const value = Math.abs(cents) / 100;
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return cents < 0 ? `-${text}` : text;
};

export function newPoker(title: string, now = Date.now()): PokerGame {
  return { title: title || "Poker night", startedAt: now, players: [], settled: false, payouts: null };
}

/** Exact name, then a unique first-name or prefix match. */
export function findPokerPlayer(game: PokerGame, name: string): PokerPlayer | null {
  const key = nameKey(name.replace(/^@/, ""));
  if (!key) return null;
  const exact = game.players.find((player) => nameKey(player.name) === key);
  if (exact) return exact;
  const loose = game.players.filter((player) => nameKey(player.name).split(" ")[0] === key || nameKey(player.name).startsWith(key));
  return loose.length === 1 ? loose[0] : null;
}

function amountCents(amount: number, allowZero: boolean): number {
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) throw new PokerError(`amount must be a ${allowZero ? "non-negative" : "positive"} number`);
  if (amount > MAX_AMOUNT) throw new PokerError(`amount must be at most ${MAX_AMOUNT}`);
  return toCents(amount);
}

function open(game: PokerGame) {
  if (game.settled) throw new PokerError("this game is settled; start a new one");
}

/** A buy-in or rebuy. A name not at the table yet joins it. */
export function buyIn(game: PokerGame, name: string, amount: number): PokerPlayer {
  open(game);
  const cents = amountCents(amount, false);
  let player = findPokerPlayer(game, name);
  if (!player) {
    const clean = name.replace(/^@/, "").trim().slice(0, 40);
    if (!clean) throw new PokerError("who is buying in?");
    if (game.players.length >= MAX_PLAYERS) throw new PokerError(`the table is full (${MAX_PLAYERS} players)`);
    player = { name: clean, buyIns: [], stack: null, cashedOut: false };
    game.players.push(player);
  }
  player.buyIns.push(cents);
  player.cashedOut = false;
  return player;
}

function seated(game: PokerGame, name: string): PokerPlayer {
  const player = findPokerPlayer(game, name);
  if (!player) throw new PokerError(`${name} isn't at the table (${game.players.map((p) => p.name).join(", ") || "nobody has bought in"})`);
  return player;
}

/** A chip count for someone still playing. */
export function setStack(game: PokerGame, name: string, amount: number): PokerPlayer {
  open(game);
  const player = seated(game, name);
  player.stack = amountCents(amount, true);
  return player;
}

/** Leaving with `amount`: their final stack. */
export function cashOut(game: PokerGame, name: string, amount: number): PokerPlayer {
  open(game);
  const player = seated(game, name);
  player.stack = amountCents(amount, true);
  player.cashedOut = true;
  return player;
}

export const totalIn = (player: PokerPlayer) => player.buyIns.reduce((sum, cents) => sum + cents, 0);
export const netOf = (player: PokerPlayer) => (player.stack === null ? null : player.stack - totalIn(player));

/**
 * Who pays whom, in as few transfers as this finds: first every debtor and creditor owed exactly the same amount
 * are paired, then the biggest debtor pays the biggest creditor until everyone is square (never more than one
 * fewer transfer than there are people with a non-zero result). Nets must add up to zero.
 */
export function settle(nets: { name: string; net: number }[]): Transfer[] {
  const sum = nets.reduce((total, row) => total + row.net, 0);
  if (sum !== 0) throw new PokerError(`results don't add up (off by ${formatAmount(sum)})`);
  const debtors = nets.filter((row) => row.net < 0).map((row) => ({ name: row.name, left: -row.net }));
  const creditors = nets.filter((row) => row.net > 0).map((row) => ({ name: row.name, left: row.net }));
  const transfers: Transfer[] = [];
  for (const debtor of debtors) {
    const match = creditors.find((creditor) => creditor.left === debtor.left);
    if (!match) continue;
    transfers.push({ from: debtor.name, to: match.name, amount: debtor.left });
    match.left = 0;
    debtor.left = 0;
  }
  for (;;) {
    const debtor = debtors.filter((row) => row.left > 0).sort((a, b) => b.left - a.left)[0];
    const creditor = creditors.filter((row) => row.left > 0).sort((a, b) => b.left - a.left)[0];
    if (!debtor || !creditor) break;
    const amount = Math.min(debtor.left, creditor.left);
    transfers.push({ from: debtor.name, to: creditor.name, amount });
    debtor.left -= amount;
    creditor.left -= amount;
  }
  return transfers;
}

/** Ends the game: every stack must be counted and the chips must match the buy-ins. */
export function settleGame(game: PokerGame): Transfer[] {
  open(game);
  if (!game.players.length) throw new PokerError("nobody has bought in");
  const missing = game.players.filter((player) => player.stack === null).map((player) => player.name);
  if (missing.length) throw new PokerError(`I still need a final stack for ${missing.join(", ")}`);
  const chips = game.players.reduce((sum, player) => sum + (player.stack ?? 0), 0);
  const bought = game.players.reduce((sum, player) => sum + totalIn(player), 0);
  if (chips !== bought) {
    throw new PokerError(`stacks add up to ${formatAmount(chips)} but buy-ins to ${formatAmount(bought)} (${chips > bought ? "extra" : "missing"} ${formatAmount(Math.abs(chips - bought))}); recount and fix a stack`);
  }
  const payouts = settle(game.players.map((player) => ({ name: player.name, net: netOf(player) ?? 0 })));
  game.settled = true;
  game.payouts = payouts;
  return payouts;
}

/** What the TV's game widget shows. Amounts in whole units (cents / 100). */
export function pokerScreen(game: PokerGame): GameScreen {
  const players = [...game.players]
    .sort((a, b) => (netOf(b) ?? -Infinity) - (netOf(a) ?? -Infinity) || totalIn(b) - totalIn(a))
    .map((player) => ({ name: player.name, buyIn: totalIn(player) / 100, stack: player.stack === null ? null : player.stack / 100, net: netOf(player) === null ? null : (netOf(player) as number) / 100, out: player.cashedOut }));
  const pot = game.players.reduce((sum, player) => sum + totalIn(player), 0);
  return {
    kind: "poker",
    title: game.title,
    status: game.settled ? "settled" : "live",
    players: players.slice(0, MAX_PLAYERS),
    payouts: (game.payouts ?? []).slice(0, MAX_PLAYERS).map((transfer) => ({ from: transfer.from, to: transfer.to, amount: transfer.amount / 100 })),
    note: game.settled ? (game.payouts?.length ? null : "Everyone broke even.") : `${formatAmount(pot)} bought in across ${game.players.length} ${game.players.length === 1 ? "player" : "players"}`,
  };
}

export function describeTable(game: PokerGame): string {
  if (!game.players.length) return `${game.title}: nobody has bought in yet.`;
  const rows = game.players.map((player) => {
    const net = netOf(player);
    return `${player.name}: in ${formatAmount(totalIn(player))}${player.buyIns.length > 1 ? ` (${player.buyIns.length} buys)` : ""}${player.stack === null ? "" : `, ${player.cashedOut ? "out with" : "stack"} ${formatAmount(player.stack)} (${net !== null && net >= 0 ? "+" : ""}${formatAmount(net ?? 0)})`}`;
  });
  return `${game.title}:\n${rows.join("\n")}`;
}

export function describePayouts(payouts: Transfer[]): string {
  if (!payouts.length) return "Everyone broke even. Nobody owes anybody.";
  return payouts.map((transfer) => `${transfer.from} pays ${transfer.to} ${formatAmount(transfer.amount)}`).join("\n");
}

// --- Service: the one active game, saved and shown --------------------------------------------

let current: { id: number; game: PokerGame } | null | undefined;

function active(): { id: number; game: PokerGame } | null {
  if (current === undefined) {
    const row = loadActive<PokerGame>("poker");
    current = row ? { id: row.id, game: row.state } : null;
  }
  return current;
}

/** For tests: forget the cached game so the next call reads the database again. */
export function resetPokerCache() {
  current = undefined;
}

export const activePoker = () => active()?.game ?? null;

async function show(game: PokerGame, dryRun: boolean): Promise<string | null> {
  const result = await pushScreen({ op: "game", game: pokerScreen(game) }, { dryRun });
  if (!result.ok) return result.error ?? "the TV said no";
  const placed = await ensureWidget("game", "center", { dryRun });
  return placed && !placed.ok ? placed.error ?? "the TV said no" : null;
}

const tvNote = (error: string | null) => (error ? ` (TV: ${error})` : "");

export type PokerAction =
  | { action: "start"; title?: string; players?: string[]; amount?: number }
  | { action: "buy_in"; player: string; amount: number }
  | { action: "stack"; player: string; amount: number }
  | { action: "cash_out"; player: string; amount: number }
  | { action: "settle" }
  | { action: "status" }
  | { action: "end" };

type PokerResult = { ok: boolean; reply: string; game?: PokerGame | null; payouts?: Transfer[] };
type TableAction = Extract<PokerAction, { action: "buy_in" | "stack" | "cash_out" | "settle" }>;
type TableChange = { reply: string; payouts?: Transfer[] };

const upOrDown = (net: number) => `${net >= 0 ? "up" : "down"} ${formatAmount(Math.abs(net))}`;

function seat(game: PokerGame, name: string, amount: number | undefined) {
  if (amount) buyIn(game, name, amount);
  else if (!findPokerPlayer(game, name)) game.players.push({ name: name.replace(/^@/, "").trim().slice(0, 40), buyIns: [], stack: null, cashedOut: false });
}

async function startPoker(request: Extract<PokerAction, { action: "start" }>, dryRun: boolean): Promise<PokerResult> {
  const game = newPoker(request.title ?? "");
  for (const name of request.players ?? []) seat(game, name, request.amount);
  current = { id: createGame("poker", game), game };
  const error = await show(game, dryRun);
  const seatedNames = game.players.map((player) => player.name).join(", ");
  const each = request.amount ? `, ${formatAmount(toCents(request.amount))} each` : "";
  const table = seatedNames ? ` At the table: ${seatedNames}${each}.` : "";
  return { ok: true, game, reply: `${game.title} is on.${table} Tell me "buy in 20 for @name", "@name stack 45" and "cash out @name 60"; "settle poker" at the end.${tvNote(error)}` };
}

async function closePoker(entry: { id: number; game: PokerGame }, dryRun: boolean): Promise<PokerResult> {
  saveGame(entry.id, entry.game, false);
  current = null;
  const result = await pushScreen({ op: "clear_game" }, { dryRun });
  return { ok: true, game: null, reply: `Poker game closed.${tvNote(result.ok ? null : result.error ?? "the TV said no")}` };
}

const pokerStatus = (game: PokerGame): PokerResult => ({
  ok: true,
  game,
  reply: game.settled && game.payouts ? `${describeTable(game)}\n\nSettled:\n${describePayouts(game.payouts)}` : describeTable(game),
});

const TABLE_CHANGES: { [Action in TableAction["action"]]: (game: PokerGame, request: Extract<TableAction, { action: Action }>) => TableChange } = {
  buy_in(game, request) {
    const player = buyIn(game, request.player, request.amount);
    return { reply: `${player.name} ${player.buyIns.length > 1 ? "rebuys" : "buys in"} for ${formatAmount(toCents(request.amount))} (${formatAmount(totalIn(player))} in total).` };
  },
  stack(game, request) {
    const player = setStack(game, request.player, request.amount);
    return { reply: `${player.name} has ${formatAmount(player.stack ?? 0)} (${upOrDown(netOf(player) ?? 0)}).` };
  },
  cash_out(game, request) {
    const player = cashOut(game, request.player, request.amount);
    return { reply: `${player.name} cashes out with ${formatAmount(player.stack ?? 0)}: ${upOrDown(netOf(player) ?? 0)}.` };
  },
  settle(game) {
    const payouts = settleGame(game);
    return { reply: `Settled. ${describePayouts(payouts)}`, payouts };
  },
};

function changeTable(game: PokerGame, request: TableAction): TableChange {
  const change = TABLE_CHANGES[request.action] as (game: PokerGame, request: TableAction) => TableChange;
  return change(game, request);
}

async function runPokerAction(request: PokerAction, dryRun: boolean): Promise<PokerResult> {
  if (request.action === "start") return startPoker(request, dryRun);
  const entry = active();
  if (!entry) return { ok: false, reply: 'No poker game running. Say "start poker" first.' };
  const { game } = entry;
  if (request.action === "status") return pokerStatus(game);
  if (request.action === "end") return closePoker(entry, dryRun);
  const { reply, payouts } = changeTable(game, request);
  saveGame(entry.id, game, true);
  const error = await show(game, dryRun);
  return { ok: true, game, reply: `${reply}${tvNote(error)}`, payouts };
}

/** Runs one poker action and says what happened. Never throws for a bad request; it explains instead. */
export async function runPoker(request: PokerAction, options: { dryRun: boolean }): Promise<PokerResult> {
  try {
    return await runPokerAction(request, options.dryRun);
  } catch (error) {
    if (error instanceof PokerError) return { ok: false, reply: `${error.message.charAt(0).toUpperCase()}${error.message.slice(1)}.` };
    throw error;
  }
}
