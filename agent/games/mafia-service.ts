// Mafia, the running game: one at a time, saved in SQLite (agent/games/store.ts) after every change, its clock a
// timer in this process (picked up again on restart), roles and night actions by Slack DM, announcements in the
// game's thread, and the phase, timer and players on the TV (the `game` widget).
//
// Every change goes through one queue, so a DM, a vote and the timer can never interleave half-way.

import { dmUser, postMessage } from "../slack-api";
import { ensureWidget, pushScreen, type GameScreen, type ScreenOp, type ScreenResult } from "../screen";
import { config } from "../config";
import { logEvent } from "../db";
import {
  ROLE_LABEL,
  assignRoles,
  castVote,
  living,
  newMafia,
  nightComplete,
  nightPrompt,
  playerById,
  resolveDay,
  resolveNight,
  roleMessage,
  submitNight,
  tally,
  type MafiaGame,
  type NightAction,
} from "./mafia";
import { createGame, loadActive, saveGame } from "./store";

/** The finished game stays on the TV this long. */
const OVER_ON_SCREEN_MS = 5 * 60_000;

/** Everything with a side effect, so tests can record it instead. */
export type GameIo = {
  dm(userId: string, text: string): Promise<void>;
  post(channel: string, text: string, threadTs: string | null): Promise<{ ts: string | null }>;
  screen(op: ScreenOp): Promise<ScreenResult>;
  place(): Promise<ScreenResult | null>;
  now(): number;
};

const realIo: GameIo = {
  dm: async (userId, text) => {
    await dmUser(userId, text);
  },
  post: (channel, text, threadTs) => postMessage(channel, text, threadTs),
  screen: (op) => pushScreen(op),
  place: () => ensureWidget("game", "center"),
  now: () => Date.now(),
};

let io: GameIo = realIo;

/** For tests: record side effects (pass null to go back to Slack and the TV). */
export function setGameIo(next: GameIo | null) {
  io = next ?? realIo;
}

const SYSTEM = { id: null, name: "mafia", source: "scheduler" } as const;

let current: { id: number; game: MafiaGame } | null | undefined;
let timer: NodeJS.Timeout | null = null;
let clearTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

function locked<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

function active(): { id: number; game: MafiaGame } | null {
  if (current === undefined) {
    const row = loadActive<MafiaGame>("mafia");
    current = row ? { id: row.id, game: row.state } : null;
  }
  return current;
}

export const activeMafia = () => active()?.game ?? null;

/** For tests: drop the cached game and timers. */
export function resetMafia() {
  stopMafiaTimers();
  current = undefined;
}

export function stopMafiaTimers() {
  if (timer) clearTimeout(timer);
  if (clearTimer) clearTimeout(clearTimer);
  timer = null;
  clearTimer = null;
}

// --- Output ----------------------------------------------------------------------------------

export function mafiaScreen(game: MafiaGame): GameScreen {
  const counts = game.phase === "day" ? tally(game).counts : {};
  return {
    kind: "mafia",
    phase: game.phase,
    round: game.round,
    endsAt: game.endsAt,
    headline: game.headline,
    detail: game.detail,
    // Roles show only for the dead, and for everyone once it is over.
    players: game.players.map((player) => ({
      name: player.name,
      alive: player.alive,
      role: !player.alive || game.phase === "over" ? player.role : null,
      votes: counts[player.id] ?? 0,
    })),
    winner: game.winner,
  };
}

async function draw(game: MafiaGame) {
  const result = await io.screen({ op: "game", game: mafiaScreen(game) });
  if (!result.ok) console.warn(`[jarvis] mafia: TV refused the game: ${result.error}`);
  else await io.place();
}

async function announce(game: MafiaGame, text: string) {
  if (!game.channel) return;
  try {
    await io.post(game.channel, text, game.threadTs);
  } catch (error) {
    console.error("[jarvis] mafia announcement failed:", error instanceof Error ? error.message : error);
  }
}

async function dm(userId: string, text: string) {
  try {
    await io.dm(userId, text);
  } catch (error) {
    console.error(`[jarvis] mafia DM to ${userId} failed:`, error instanceof Error ? error.message : error);
  }
}

async function nightDms(game: MafiaGame) {
  for (const player of living(game)) {
    const prompt = nightPrompt(game, player);
    if (prompt) await dm(player.id, prompt);
  }
}

function save(entry: { id: number; game: MafiaGame }) {
  saveGame(entry.id, entry.game, entry.game.phase !== "over");
}

const reveal = (game: MafiaGame) => game.players.map((player) => `${player.name}: ${ROLE_LABEL[player.role]}${player.alive ? "" : " (dead)"}`).join("\n");

// --- Clock -----------------------------------------------------------------------------------

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const game = active()?.game;
  if (!game) return;
  if (game.phase === "over") {
    if (clearTimer) clearTimeout(clearTimer);
    clearTimer = setTimeout(() => void io.screen({ op: "clear_game" }), OVER_ON_SCREEN_MS);
    clearTimer.unref?.();
    return;
  }
  if (game.endsAt === null) return;
  timer = setTimeout(() => void locked(() => advance("timer")), Math.max(0, game.endsAt - io.now()) + 100);
  timer.unref?.();
}

/** Ends the phase now (its timer ran out, everyone acted, or the host said "mafia next"). Lock held. */
async function advance(why: "timer" | "complete" | "host"): Promise<string> {
  const entry = active();
  if (!entry || entry.game.phase === "over") return "No game running.";
  const { game } = entry;
  let text: string;
  // resolveNight / resolveDay move the phase on; read it again after.
  const phaseOf = () => game.phase as MafiaGame["phase"];
  if (game.phase === "night") {
    resolveNight(game, io.now());
    text = phaseOf() === "over" ? `${game.detail ? `${game.headline} ${game.detail}` : game.headline}` : `*Day ${game.round}.* ${game.headline}\nDiscuss, then vote: reply \`vote @name\` here (or DM me \`vote name\`), \`vote skip\` to pass. ${game.daySeconds} seconds.`;
  } else {
    resolveDay(game, io.now());
    text = phaseOf() === "over" ? `${game.headline} ${game.detail ?? ""}` : `*Night ${game.round}.* ${game.headline.replace(/ Night \d+ falls\.$/, "")} Mafia, doctor, detective: check your DMs.`;
  }
  save(entry);
  logEvent(SYSTEM, "scheduler", `mafia_${game.phase}`, { why, round: game.round }, true, game.headline);
  await draw(game);
  if (game.phase === "over") {
    await announce(game, `${text}\n\nRoles:\n${reveal(game)}`);
    for (const player of game.players) await dm(player.id, `${game.headline} ${game.winner === (player.role === "mafia" ? "mafia" : "town") ? "You won." : "You lost."}`);
  } else {
    await announce(game, text);
    if (game.phase === "night") await nightDms(game);
  }
  schedule();
  return text;
}

// --- Commands --------------------------------------------------------------------------------

export type StartOptions = {
  players: { id: string; name: string }[];
  channel: string | null;
  threadTs: string | null;
  nightSeconds?: number;
  daySeconds?: number;
  rng?: () => number;
};

export function startMafia(options: StartOptions): Promise<{ ok: boolean; reply: string; game?: MafiaGame }> {
  return locked(async () => {
    let players;
    try {
      players = assignRoles(options.players, options.rng);
    } catch (error) {
      return { ok: false, reply: `${error instanceof Error ? error.message : "Can't start"}.` };
    }
    stopMafiaTimers();
    const previous = active();
    if (previous && previous.game.phase !== "over") saveGame(previous.id, { ...previous.game, phase: "over", endsAt: null }, false);

    let channel = options.channel || config.slackChannel() || "";
    let threadTs = options.threadTs;
    const game = newMafia({ players, channel: channel || null, threadTs, nightSeconds: options.nightSeconds, daySeconds: options.daySeconds, now: io.now() });
    const names = players.map((player) => player.name).join(", ");
    const mafia = players.filter((player) => player.role === "mafia").length;
    const opening = `*Mafia* with ${names}. ${mafia} mafia, one doctor, one detective, ${players.length - mafia - 2} villager${players.length - mafia - 2 === 1 ? "" : "s"}. Roles are in your DMs. *Night 1* starts now (${game.nightSeconds}s); days are ${game.daySeconds}s.`;
    // Started outside a thread (a DM, or the main channel): the opening post becomes the game's thread.
    if (channel && !threadTs) {
      try {
        threadTs = (await io.post(channel, opening, null)).ts;
      } catch (error) {
        console.error("[jarvis] mafia opening post failed:", error instanceof Error ? error.message : error);
        channel = "";
      }
      game.channel = channel || null;
      game.threadTs = threadTs;
    }
    current = { id: createGame("mafia", game), game };
    for (const player of players) await dm(player.id, `*Mafia is starting.* ${roleMessage(game, player)}`);
    await draw(game);
    await nightDms(game);
    schedule();
    logEvent(SYSTEM, "scheduler", "mafia_start", { players: players.map((player) => player.name) }, true, null);
    return { ok: true, reply: options.threadTs || !game.threadTs ? opening : `Mafia is on with ${names}; follow along in the game thread.`, game };
  });
}

export function endMafia(): Promise<{ ok: boolean; reply: string }> {
  return locked(async () => {
    const entry = active();
    stopMafiaTimers();
    if (!entry || entry.game.phase === "over") {
      await io.screen({ op: "clear_game" });
      current = null;
      return { ok: false, reply: "No Mafia game running." };
    }
    const { game } = entry;
    game.phase = "over";
    game.endsAt = null;
    game.headline = "Game called off.";
    game.detail = null;
    saveGame(entry.id, game, false);
    current = null;
    await io.screen({ op: "clear_game" });
    await announce(game, `Game called off. Roles were:\n${reveal(game)}`);
    return { ok: true, reply: "Mafia ended. Roles posted in the game thread." };
  });
}

/** The host skips the rest of the phase. */
export function nextMafiaPhase(): Promise<{ ok: boolean; reply: string }> {
  return locked(async () => {
    const game = active()?.game;
    if (!game || game.phase === "over") return { ok: false, reply: "No Mafia game running." };
    return { ok: true, reply: await advance("host") };
  });
}

/** Public status only: never anyone's role while they are alive. */
export function mafiaStatus(): { ok: boolean; reply: string; screen?: GameScreen } {
  const game = active()?.game;
  if (!game) return { ok: false, reply: "No Mafia game running." };
  const left = game.endsAt ? Math.max(0, Math.round((game.endsAt - io.now()) / 1000)) : null;
  const alive = living(game).map((player) => player.name);
  const dead = game.players.filter((player) => !player.alive).map((player) => `${player.name} (${ROLE_LABEL[player.role]})`);
  const phase = game.phase === "over" ? game.headline : `${game.phase === "night" ? "Night" : "Day"} ${game.round}, ${left}s left.`;
  return { ok: true, reply: `${phase} Alive: ${alive.join(", ")}.${dead.length ? ` Dead: ${dead.join(", ")}.` : ""}`, screen: mafiaScreen(game) };
}

const ACTION_WORDS: Array<[RegExp, NightAction | "vote"]> = [
  [/^(?:kill|murder|eliminate|whack|target|hit)\s+(.+)$/i, "kill"],
  [/^(?:save|protect|heal|guard)\s+(.+)$/i, "save"],
  [/^(?:check|investigate|inspect|look at)\s+(.+)$/i, "check"],
  [/^(?:vote(?:\s+(?:for|out))?|lynch|i vote(?:\s+for)?)\s+(.+)$/i, "vote"],
];

export type GameMessage = {
  userId: string | null | undefined;
  /** Normalised text (wake word and bot mention removed). Mentions may be "@Name". */
  text: string;
  /** The message as Slack sent it, with <@U123> mentions, when known. */
  rawText?: string | null;
  place?: string;
  channel?: string | null;
  threadTs?: string | null;
};

/**
 * A message from a player that is a game action: in a DM, night actions, votes, "role" and "players"; in the
 * game's thread, votes. Returns the reply, or null when it is not for the game (it then goes to the usual turn).
 */
export function handleMafiaMessage(message: GameMessage): Promise<string | null> | null {
  const entry = active();
  if (!entry || !message.userId) return null;
  const { game } = entry;
  const player = playerById(game, message.userId);
  if (!player || game.phase === "over") return null;
  const inThread = Boolean(game.threadTs && message.threadTs === game.threadTs && (!game.channel || message.channel === game.channel));
  const isDm = message.place === "dm";
  if (!isDm && !inThread) return null;
  const text = message.text.trim().replace(/[.!?]+$/, "");

  if (isDm && /^(?:role|my role|what(?:'s| is) my role|who am i)$/i.test(text)) return Promise.resolve(roleMessage(game, player));
  if (/^(?:players|alive|who'?s alive|who is alive|list)$/i.test(text)) return Promise.resolve(`Alive:\n${living(game).map((p, i) => `${i + 1}. ${p.name}`).join("\n")}`);
  if (/^(?:skip|abstain|no vote|vote skip|pass)$/i.test(text) && game.phase === "day") return locked(() => vote(message.userId as string, "skip"));

  for (const [pattern, action] of ACTION_WORDS) {
    const match = text.match(pattern);
    if (!match) continue;
    // Night actions only by DM: in a thread they would give the role away.
    if (action !== "vote" && !isDm) return null;
    // Prefer a real mention of a player when the raw text has one (names can be ambiguous; the bot's own
    // mention is not a player).
    const ids = [...(message.rawText ?? "").matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((found) => found[1]);
    const mentioned = ids.find((id) => playerById(game, id));
    const target = mentioned ? `<@${mentioned}>` : match[1];
    if (action === "vote") return locked(() => vote(message.userId as string, target));
    return locked(() => night(message.userId as string, action, target));
  }
  return null;
}

async function night(actorId: string, action: NightAction, target: string): Promise<string> {
  const entry = active();
  if (!entry) return "No Mafia game running.";
  const { game } = entry;
  const result = submitNight(game, actorId, action, target);
  if (!result.ok) return result.message;
  save(entry);
  logEvent({ id: actorId, name: playerById(game, actorId)?.name ?? null, source: "slack" }, "tool", `mafia_${action}`, { round: game.round }, true, null);
  if (action === "kill") {
    for (const partner of living(game).filter((player) => player.role === "mafia" && player.id !== actorId)) await dm(partner.id, `${playerById(game, actorId)?.name} picked ${result.target?.name}. Reply \`kill <name>\` to change it.`);
  }
  if (nightComplete(game)) {
    // Answer first, then end the night just after, so the reply is not lost behind the day's posts.
    setTimeout(() => void locked(() => (active()?.game === game && game.phase === "night" ? advance("complete") : Promise.resolve(""))), 1_500).unref?.();
  }
  return result.message;
}

async function vote(voterId: string, target: string): Promise<string> {
  const entry = active();
  if (!entry) return "No Mafia game running.";
  const { game } = entry;
  const result = castVote(game, voterId, target);
  if (!result.ok) return result.message;
  save(entry);
  const count = tally(game);
  await draw(game);
  const standing = count.leader ? ` ${playerById(game, count.leader)?.name} has ${count.counts[count.leader]} of ${count.needed} needed.` : "";
  if (count.majority || count.allIn) {
    setTimeout(() => void locked(() => (active()?.game === game && game.phase === "day" ? advance("complete") : Promise.resolve(""))), 1_500).unref?.();
    return `${result.message}${count.majority ? " That's a majority." : " Everyone has voted."}`;
  }
  return `${result.message}${standing}`;
}

/** On boot: picks a saved game back up (its clock carries on from where it was). */
export function resumeMafia() {
  const game = active()?.game;
  if (!game) return;
  if (game.phase !== "over") console.log(`[jarvis] Mafia resumed: ${game.phase} ${game.round}.`);
  schedule();
}

/** Lets the tests drive the clock: runs the phase end now, as the timer would. */
export const advanceForTest = () => locked(() => advance("timer"));
