// Mafia, the rules: roles, night actions, day votes, deaths and the winner. Pure functions on a plain game
// object (the service in agent/games/mafia-service.ts saves it, runs the clock, sends the DMs and draws the TV).
// Tested in agent/selftest.ts.
//
// Short games: night first, then day, and so on. Mafia pick one kill a night (the last pick by any of them stands),
// the doctor saves one player (themself too), the detective checks one player and is told by DM. Deaths reveal the
// role. Town wins when no mafia are left; mafia win once they are at least as many as everyone else.

import { nameKey } from "../db";

export type Role = "mafia" | "doctor" | "detective" | "villager";
export type Team = "town" | "mafia";
export type MafiaPlayer = { id: string; name: string; role: Role; alive: boolean; died: { round: number; how: "killed" | "voted" } | null };
export type MafiaPhase = "night" | "day" | "over";
export type NightAction = "kill" | "save" | "check";

export type MafiaGame = {
  startedAt: number;
  /** Where the game is announced, and the thread day votes can be replied in. */
  channel: string | null;
  threadTs: string | null;
  players: MafiaPlayer[];
  phase: MafiaPhase;
  /** Night 1, day 1, night 2... */
  round: number;
  /** When the current phase ends on its own (epoch ms), null once over. */
  endsAt: number | null;
  nightSeconds: number;
  daySeconds: number;
  night: { kill: string | null; killBy: string | null; save: string | null; check: string | null };
  /** Voter id to target id, or "skip". */
  votes: Record<string, string>;
  /** The big line and the small one on the TV. */
  headline: string;
  detail: string | null;
  winner: Team | null;
};

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 16;
export const DEFAULT_NIGHT_SECONDS = 60;
export const DEFAULT_DAY_SECONDS = 150;

export const ROLE_LABEL: Record<Role, string> = { mafia: "Mafia", doctor: "Doctor", detective: "Detective", villager: "Villager" };
export const teamOf = (role: Role): Team => (role === "mafia" ? "mafia" : "town");

/** About one in four is mafia: 1 for 4-5 players, 2 for 6-9, 3 for 10-13, 4 for 14-16. */
export function mafiaCount(players: number): number {
  return Math.max(1, Math.round(players / 4));
}

/** Every player gets one role at random: the mafia, one doctor, one detective, the rest villagers. */
export function assignRoles(players: { id: string; name: string }[], rng: () => number = Math.random): MafiaPlayer[] {
  const unique = players.filter((player, index) => players.findIndex((other) => other.id === player.id) === index);
  if (unique.length < MIN_PLAYERS) throw new Error(`Mafia needs at least ${MIN_PLAYERS} players (got ${unique.length})`);
  if (unique.length > MAX_PLAYERS) throw new Error(`Mafia takes at most ${MAX_PLAYERS} players (got ${unique.length})`);
  const roles: Role[] = [...Array<Role>(mafiaCount(unique.length)).fill("mafia"), "doctor", "detective"];
  while (roles.length < unique.length) roles.push("villager");
  // Fisher-Yates.
  for (let i = roles.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return unique.map((player, index) => ({ id: player.id, name: player.name, role: roles[index], alive: true, died: null }));
}

export function newMafia(options: { players: MafiaPlayer[]; channel: string | null; threadTs: string | null; nightSeconds?: number; daySeconds?: number; now?: number }): MafiaGame {
  const game: MafiaGame = {
    startedAt: options.now ?? Date.now(),
    channel: options.channel,
    threadTs: options.threadTs,
    players: options.players,
    phase: "night",
    round: 0,
    endsAt: null,
    nightSeconds: options.nightSeconds ?? DEFAULT_NIGHT_SECONDS,
    daySeconds: options.daySeconds ?? DEFAULT_DAY_SECONDS,
    night: { kill: null, killBy: null, save: null, check: null },
    votes: {},
    headline: "",
    detail: null,
    winner: null,
  };
  startNight(game, options.now ?? Date.now());
  return game;
}

export const living = (game: MafiaGame) => game.players.filter((player) => player.alive);
export const playerById = (game: MafiaGame, id: string | null | undefined) => (id ? game.players.find((player) => player.id === id) ?? null : null);

/** Alive players, numbered the way the night DMs list them (1-based). */
export function numberedLiving(game: MafiaGame): string {
  return living(game)
    .map((player, index) => `${index + 1}. ${player.name}`)
    .join("\n");
}

/**
 * The player `text` names, among the living: a Slack mention (<@U123>), a number from the DM list, an exact name,
 * or a unique first name or prefix. "@" in front of a name is ignored.
 */
export function findTarget(game: MafiaGame, text: string): MafiaPlayer | null {
  const alive = living(game);
  const mention = text.match(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/);
  if (mention) return alive.find((player) => player.id === mention[1]) ?? null;
  const trimmed = text.trim().replace(/^@/, "").replace(/[.!?]+$/, "");
  if (/^\d{1,2}$/.test(trimmed)) return alive[Number(trimmed) - 1] ?? null;
  const key = nameKey(trimmed);
  if (!key) return null;
  const exact = alive.filter((player) => nameKey(player.name) === key);
  if (exact.length === 1) return exact[0];
  const loose = alive.filter((player) => nameKey(player.name).split(" ")[0] === key || nameKey(player.name).startsWith(key));
  return loose.length === 1 ? loose[0] : null;
}

const ACTION_ROLE: Record<NightAction, Role> = { kill: "mafia", save: "doctor", check: "detective" };

export type ActionResult = { ok: boolean; message: string; target?: MafiaPlayer; checkedTeam?: Team };

type NightHandler = (game: MafiaGame, actor: MafiaPlayer, target: MafiaPlayer) => ActionResult;

const NIGHT_HANDLERS: Record<NightAction, NightHandler> = {
  kill(game, actor, target) {
    if (target.role === "mafia") return { ok: false, message: `${target.name} is mafia too. Pick someone else.` };
    game.night.kill = target.id;
    game.night.killBy = actor.id;
    return { ok: true, message: `Marked: ${target.name}.`, target };
  },
  save(game, actor, target) {
    game.night.save = target.id;
    return { ok: true, message: `You'll watch over ${target.id === actor.id ? "yourself" : target.name} tonight.`, target };
  },
  check(game, actor, target) {
    if (target.id === actor.id) return { ok: false, message: "You already know you're innocent. Check someone else." };
    if (game.night.check) return { ok: false, message: `You already checked ${playerById(game, game.night.check)?.name ?? "someone"} tonight.` };
    game.night.check = target.id;
    const team = teamOf(target.role);
    return { ok: true, message: `${target.name} is ${team === "mafia" ? "*MAFIA*" : "not mafia"}.`, target, checkedTeam: team };
  },
};

/** Why `actor` cannot take `action` right now, or null when they can. */
function nightRefusal(game: MafiaGame, actor: MafiaPlayer, action: NightAction): string | null {
  if (!actor.alive) return "You're dead. The dead don't get a night action.";
  if (game.phase !== "night") return game.phase === "day" ? "It's day. Night actions wait for nightfall; vote instead." : "The game is over.";
  if (actor.role !== ACTION_ROLE[action]) return `Only the ${ROLE_LABEL[ACTION_ROLE[action]].toLowerCase()} can ${action}. You're ${article(actor.role)}.`;
  return null;
}

/** A night action by DM. Checks the phase, the actor's role and the target. */
export function submitNight(game: MafiaGame, actorId: string, action: NightAction, targetText: string): ActionResult {
  const actor = playerById(game, actorId);
  if (!actor) return { ok: false, message: "You're not in this game." };
  const refusal = nightRefusal(game, actor, action);
  if (refusal) return { ok: false, message: refusal };
  const target = findTarget(game, targetText);
  if (!target) return { ok: false, message: `I can't tell who "${targetText}" is. Reply with a name or number:\n${numberedLiving(game)}` };
  return NIGHT_HANDLERS[action](game, actor, target);
}

const article = (role: Role) => (role === "mafia" ? "mafia" : `the ${ROLE_LABEL[role].toLowerCase()}`.replace("the villager", "a villager"));

/** Every living role with a night action has used it. */
export function nightComplete(game: MafiaGame): boolean {
  if (game.phase !== "night") return false;
  const has = (role: Role) => living(game).some((player) => player.role === role);
  return Boolean(game.night.kill) && (!has("doctor") || Boolean(game.night.save)) && (!has("detective") || Boolean(game.night.check));
}

export function winnerOf(game: MafiaGame): Team | null {
  const alive = living(game);
  const mafia = alive.filter((player) => player.role === "mafia").length;
  if (mafia === 0) return "town";
  if (mafia >= alive.length - mafia) return "mafia";
  return null;
}

function finish(game: MafiaGame, winner: Team, lead: string) {
  game.phase = "over";
  game.endsAt = null;
  game.winner = winner;
  game.headline = winner === "town" ? "Town wins." : "Mafia wins.";
  const mafia = game.players.filter((player) => player.role === "mafia").map((player) => player.name);
  game.detail = `${lead} The mafia: ${mafia.join(", ")}.`;
}

export function startNight(game: MafiaGame, now: number) {
  game.phase = "night";
  game.round += 1;
  game.endsAt = now + game.nightSeconds * 1000;
  game.night = { kill: null, killBy: null, save: null, check: null };
  game.votes = {};
  game.headline = `Night ${game.round}. Everyone close your eyes.`;
  game.detail = "Mafia, doctor and detective: check your Slack DMs.";
}

export function startDay(game: MafiaGame, now: number, lead: string) {
  game.phase = "day";
  game.endsAt = now + game.daySeconds * 1000;
  game.votes = {};
  game.headline = lead;
  game.detail = "Discuss, then vote: reply “vote @name” in the game thread or DM Worm. “vote skip” to pass.";
}

/** Ends the night: the kill lands unless the doctor saved that player. Then day, or the end. */
export function resolveNight(game: MafiaGame, now: number): { died: MafiaPlayer | null; saved: boolean } {
  const target = playerById(game, game.night.kill);
  const saved = Boolean(target && game.night.save === target.id);
  const died = target && !saved ? target : null;
  if (died) {
    died.alive = false;
    died.died = { round: game.round, how: "killed" };
  }
  const lead = died ? `${died.name} was killed in the night. They were ${article(died.role)}.` : saved ? "The mafia struck, but the doctor got there first. Nobody died." : "A quiet night. Nobody died.";
  const winner = winnerOf(game);
  if (winner) finish(game, winner, lead);
  else startDay(game, now, lead);
  return { died, saved };
}

/** A day vote by a living player, for a living player or "skip". Changing your vote is allowed. */
export function castVote(game: MafiaGame, voterId: string, targetText: string): ActionResult {
  const voter = playerById(game, voterId);
  if (!voter) return { ok: false, message: "You're not in this game." };
  if (!voter.alive) return { ok: false, message: "You're dead. Ghosts don't vote." };
  if (game.phase !== "day") return { ok: false, message: game.phase === "night" ? "It's night. Voting opens at daybreak." : "The game is over." };
  if (/^(?:skip|nobody|no one|none|pass|abstain)$/i.test(targetText.trim())) {
    game.votes[voter.id] = "skip";
    return { ok: true, message: `${voter.name} votes to skip.` };
  }
  const target = findTarget(game, targetText);
  if (!target) return { ok: false, message: `I can't tell who "${targetText}" is. Alive: ${living(game).map((player) => player.name).join(", ")}.` };
  game.votes[voter.id] = target.id;
  return { ok: true, message: `${voter.name} votes for ${target.name}.`, target };
}

export type Tally = { counts: Record<string, number>; skip: number; leader: string | null; needed: number; majority: boolean; allIn: boolean };

/** Votes from living players only. `leader` is the single player with the most votes (null on a tie). */
export function tally(game: MafiaGame): Tally {
  const alive = living(game);
  const counts: Record<string, number> = {};
  let skip = 0;
  let cast = 0;
  for (const player of alive) {
    const vote = game.votes[player.id];
    if (!vote) continue;
    cast += 1;
    if (vote === "skip") skip += 1;
    else if (playerById(game, vote)?.alive) counts[vote] = (counts[vote] ?? 0) + 1;
  }
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const leader = top && (ranked.length === 1 || ranked[1][1] < top[1]) ? top[0] : null;
  const needed = Math.floor(alive.length / 2) + 1;
  return { counts, skip, leader, needed, majority: Boolean(leader && counts[leader] >= needed), allIn: cast === alive.length };
}

/**
 * Ends the day. With a majority the leader is out; when time runs out, the single leader is out if they have more
 * votes than "skip" did; a tie, or skip ahead, and nobody is.
 */
export function resolveDay(game: MafiaGame, now: number): { eliminated: MafiaPlayer | null } {
  const result = tally(game);
  const leader = playerById(game, result.leader);
  const eliminated = leader && (result.majority || result.counts[leader.id] > result.skip) ? leader : null;
  if (eliminated) {
    eliminated.alive = false;
    eliminated.died = { round: game.round, how: "voted" };
  }
  const lead = eliminated ? `The town voted out ${eliminated.name}. They were ${article(eliminated.role)}.` : "No verdict. Nobody was voted out.";
  const winner = winnerOf(game);
  if (winner) finish(game, winner, lead);
  else {
    startNight(game, now);
    game.headline = `${lead} Night ${game.round} falls.`;
  }
  return { eliminated };
}

/** The role DM each player gets at the start. */
export function roleMessage(game: MafiaGame, player: MafiaPlayer): string {
  const how = "Reply here with a name or a number from the list I send each night.";
  switch (player.role) {
    case "mafia": {
      const others = game.players.filter((other) => other.role === "mafia" && other.id !== player.id).map((other) => other.name);
      return `You are *Mafia*. ${others.length ? `Your partner${others.length > 1 ? "s" : ""}: ${others.join(", ")}.` : "You work alone."} Each night, reply \`kill <name>\` to pick a victim. By day, blend in. ${how}`;
    }
    case "doctor":
      return `You are the *Doctor*. Each night, reply \`save <name>\` to protect one player (you can pick yourself). ${how}`;
    case "detective":
      return `You are the *Detective*. Each night, reply \`check <name>\` and I'll tell you whether they're mafia. ${how}`;
    default:
      return "You are a *Villager*. No night action: sleep, then find the mafia by day. Vote with `vote <name>` in the game thread or here.";
  }
}

/** The DM a role with a night action gets as night falls. Null for villagers. */
export function nightPrompt(game: MafiaGame, player: MafiaPlayer): string | null {
  const verb = player.role === "mafia" ? "kill" : player.role === "doctor" ? "save" : player.role === "detective" ? "check" : null;
  if (!verb || !player.alive) return null;
  const ask = player.role === "mafia" ? "Who dies tonight?" : player.role === "doctor" ? "Who do you protect?" : "Who do you investigate?";
  return `Night ${game.round}. ${ask} Reply \`${verb} <name or number>\` within ${game.nightSeconds} seconds.\n${numberedLiving(game)}`;
}
