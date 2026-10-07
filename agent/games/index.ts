// Games, the way in: the fast-path commands ("mafia start @a @b @c @d", "buy in 20 for @x"), the routing of
// players' DMs and thread replies to a running Mafia game (before the usual turn), and boot-time pick-up.
// parseGameCommand() is pure (tested in agent/selftest.ts); rules.ts calls it and runGameCommand().

import { config } from "../config";
import { postMessage } from "../slack-api";
import type { TurnContext } from "../tools/types";
import { DEFAULT_DAY_SECONDS, DEFAULT_NIGHT_SECONDS } from "./mafia";
import { endMafia, handleMafiaMessage, mafiaStatus, nextMafiaPhase, resumeMafia, startMafia, stopMafiaTimers } from "./mafia-service";
import { resolvePlayers, splitNames } from "./players";
import { runPoker, type PokerAction } from "./poker";

export type GameCommand =
  | { game: "mafia"; action: "start"; names: string[]; nightSeconds?: number; daySeconds?: number }
  | { game: "mafia"; action: "status" | "end" | "next" }
  | ({ game: "poker" } & PokerAction);

const AMOUNT = String.raw`(\d{1,7}(?:\.\d{1,2})?)`;
const WHO = String.raw`(@.+?|me|myself)`;

const amount = (text: string) => Number(text);
/** "@Alice Smith" to "Alice Smith"; "me" stays "me" (the runner puts the asker's name in). */
const who = (text: string) => text.trim().replace(/^@/, "").replace(/[,.]+$/, "").trim();

type CommandParser = (text: string) => GameCommand | null;

const MAFIA_KEYWORDS: Array<[RegExp, "status" | "end" | "next"]> = [
  [/^(?:mafia (?:status|state|players|time)|who'?s alive in mafia)$/i, "status"],
  [/^(?:(?:end|stop|cancel|abort) (?:the )?mafia(?: game)?|mafia (?:end|stop|cancel|abort|over))$/i, "end"],
  [/^(?:mafia (?:next|skip|advance)(?: phase)?|skip (?:the )?(?:mafia )?(?:phase|night|day))$/i, "next"],
];

function parseMafia(text: string): GameCommand | null {
  const match = text.match(/^(?:start (?:a )?(?:new )?(?:game of )?mafia(?: game)?|mafia start|new mafia(?: game)?|let'?s play mafia|play mafia)(?:\s*[:,-]?\s*(?:with|for)?\s*(.*))?$/i);
  if (match) return { game: "mafia", action: "start", names: splitNames(match[1] ?? "") };
  const keyword = MAFIA_KEYWORDS.find(([pattern]) => pattern.test(text));
  return keyword ? { game: "mafia", action: keyword[1] } : null;
}

function parsePokerStart(text: string): GameCommand | null {
  const match = text.match(/^(?:start (?:a )?(?:new )?poker(?: game| night)?|poker (?:start|night)|new poker game|let'?s play poker)(?:\s*[:,-]?\s*(?:with|for)\s+(.*?))?(?:\s*,?\s*(?:at\s+)?(\d{1,7}(?:\.\d{1,2})?) each)?$/i);
  if (!match) return null;
  return { game: "poker", action: "start", players: splitNames(match[1] ?? ""), ...(match[2] ? { amount: amount(match[2]) } : {}) };
}

const BUY = String.raw`(?:buy[- ]?in|buys? in|re-?buys?|add[- ]?on|adds on|top[- ]?up)`;

function parseBuyIn(text: string): GameCommand | null {
  let match = text.match(new RegExp(String.raw`^${BUY}\s+(?:for\s+|of\s+)?${AMOUNT}(?:\s+(?:for|by)\s+${WHO})?$`, "i"));
  if (match) return { game: "poker", action: "buy_in", amount: amount(match[1]), player: who(match[2] ?? "me") };
  match = text.match(new RegExp(String.raw`^${BUY}\s+${WHO}\s+(?:for\s+)?${AMOUNT}$`, "i")) ?? text.match(new RegExp(String.raw`^${WHO}\s+${BUY}\s+(?:for\s+)?${AMOUNT}$`, "i"));
  return match ? { game: "poker", action: "buy_in", player: who(match[1]), amount: amount(match[2]) } : null;
}

function parseStack(text: string): GameCommand | null {
  let match = text.match(new RegExp(String.raw`^(?:stack|chips)\s+${AMOUNT}\s+for\s+${WHO}$`, "i"));
  if (match) return { game: "poker", action: "stack", amount: amount(match[1]), player: who(match[2]) };
  match =
    text.match(new RegExp(String.raw`^(?:set\s+)?(?:stack|chips)\s+(?:for\s+)?${WHO}\s+(?:to\s+|at\s+|is\s+)?${AMOUNT}$`, "i")) ??
    text.match(new RegExp(String.raw`^(?:set\s+)?${WHO}(?:'s)?\s+(?:stack|chips)\s+(?:to\s+|at\s+|is\s+|=\s*)?${AMOUNT}$`, "i")) ??
    text.match(new RegExp(String.raw`^(?:set\s+)?(my)\s+(?:stack|chips)\s+(?:to\s+|at\s+|is\s+)?${AMOUNT}$`, "i"));
  return match ? { game: "poker", action: "stack", player: who(match[1] === "my" ? "me" : match[1]), amount: amount(match[2]) } : null;
}

const CASH = String.raw`(?:cash(?:es|ing)?[- ]?out|leaves|leaving)`;

function parseCashOut(text: string): GameCommand | null {
  let match = text.match(new RegExp(String.raw`^${CASH}\s+(?:with\s+|for\s+|at\s+)?${AMOUNT}(?:\s+for\s+${WHO})?$`, "i"));
  if (match) return { game: "poker", action: "cash_out", amount: amount(match[1]), player: who(match[2] ?? "me") };
  match = text.match(new RegExp(String.raw`^${CASH}\s+${WHO}\s+(?:with\s+|for\s+|at\s+)?${AMOUNT}$`, "i")) ?? text.match(new RegExp(String.raw`^${WHO}\s+${CASH}\s+(?:with\s+|for\s+|at\s+)?${AMOUNT}$`, "i"));
  return match ? { game: "poker", action: "cash_out", player: who(match[1]), amount: amount(match[2]) } : null;
}

const POKER_KEYWORDS: Array<[RegExp, "settle" | "status" | "end"]> = [
  [/^(?:settle(?: up)?(?: (?:the )?poker(?: game)?)?|poker (?:settle|payouts?|results|end)|end (?:the )?poker(?: game)?|who owes (?:who|whom|what)(?: in poker)?|poker who owes who)$/i, "settle"],
  [/^(?:poker(?: status| table| stacks| standings)?|poker standings)$/i, "status"],
  [/^(?:close (?:the )?poker(?: game)?|poker (?:close|clear|done)|clear (?:the )?poker(?: game)?)$/i, "end"],
];

function parsePokerKeyword(text: string): GameCommand | null {
  const keyword = POKER_KEYWORDS.find(([pattern]) => pattern.test(text));
  return keyword ? { game: "poker", action: keyword[1] } : null;
}

// Order matters: the first parser that recognises the text wins.
const PARSERS: CommandParser[] = [parseMafia, parsePokerStart, parseBuyIn, parseStack, parseCashOut, parsePokerKeyword];

/** Recognises a game command in already-normalised text (agent/rules.ts normalize()). Null if it is not one. */
export function parseGameCommand(raw: string): GameCommand | null {
  const text = raw.replace(/’/g, "'").trim();
  for (const parse of PARSERS) {
    const command = parse(text);
    if (command) return command;
  }
  return null;
}

const clampSeconds = (value: number | undefined, fallback: number) => (value && Number.isFinite(value) ? Math.max(20, Math.min(600, Math.round(value))) : fallback);

type CommandResult = { ok: boolean; reply: string };

function runPokerCommand(command: Extract<GameCommand, { game: "poker" }>, ctx: TurnContext, me: string | null): Promise<CommandResult> {
  if (!("player" in command) || !/^(?:me|myself)$/i.test(command.player)) return runPoker(command, { dryRun: ctx.dryRun });
  if (!me) return Promise.resolve({ ok: false, reply: "Who's this? Say the name: buy in 20 for @name." });
  return runPoker({ ...command, player: me }, { dryRun: ctx.dryRun });
}

const MAFIA_HOST_ACTIONS: Record<"status" | "end" | "next", () => CommandResult | Promise<CommandResult>> = {
  status: mafiaStatus,
  end: endMafia,
  next: nextMafiaPhase,
};

async function startMafiaCommand(command: Extract<GameCommand, { action: "start"; names: string[] }>, ctx: TurnContext, me: string | null): Promise<CommandResult> {
  if (!ctx.dryRun && !config.slackBotToken()) return { ok: false, reply: "Mafia needs Slack to DM the roles, and SLACK_BOT_TOKEN isn't set." };
  if (!command.names.length && !/<@[UW]/.test(ctx.rawText ?? "")) return { ok: false, reply: "Who's playing? Say “mafia start @a @b @c @d” (4 to 16 players)." };
  const { players, unknown } = await resolvePlayers(command.names, { rawText: ctx.rawText, me: ctx.who.id && me ? { id: ctx.who.id, name: me } : null });
  if (unknown.length) return { ok: false, reply: `I can't find Slack accounts for ${unknown.join(", ")}. Tag them with @ so I can DM their roles.` };
  const inDm = ctx.place === "dm";
  return startMafia({
    players,
    // From a DM the game is announced in the main channel; from a channel, in the thread it was started in.
    channel: inDm ? config.slackChannel() || ctx.channel : ctx.channel,
    threadTs: inDm && config.slackChannel() ? null : ctx.threadTs,
    nightSeconds: clampSeconds(command.nightSeconds, DEFAULT_NIGHT_SECONDS),
    daySeconds: clampSeconds(command.daySeconds, DEFAULT_DAY_SECONDS),
  });
}

/** Runs a game command for whoever asked. Shared by the rules fast path and the `poker` / `mafia` tools. */
export async function runGameCommand(command: GameCommand, ctx: TurnContext): Promise<CommandResult> {
  const me = ctx.who.name ?? null;
  if (command.game === "poker") return runPokerCommand(command, ctx, me);
  if (command.action !== "start") return MAFIA_HOST_ACTIONS[command.action]();
  return startMafiaCommand(command, ctx, me);
}

/**
 * Before the usual turn: a running Mafia game's players' DMs ("kill 2", "save me", "vote @bob") and votes in the
 * game thread go to the game. Null when the message is not for it.
 */
export function routeGameMessage(message: { userId: string | null | undefined; text: string; rawText?: string | null; place?: string; channel?: string | null; threadTs?: string | null }): Promise<string | null> | null {
  return handleMafiaMessage(message);
}

let started = false;

/** On boot: picks up a saved Mafia game and listens for votes replied in its thread without an @mention. */
export async function startGames() {
  resumeMafia();
  if (started) return;
  started = true;
  // Imported here, not at the top: agent/slack.ts imports the turn, which imports this file.
  const { onChannelMessage } = await import("../slack");
  onChannelMessage("mafia-votes", async (message) => {
    // Mentions arrive as requests too (agent/slack.ts), and go through routeGameMessage() in the turn.
    if (message.mentionsBot || !message.threadTs || !message.user || message.subtype || message.botId) return;
    const reply = await handleMafiaMessage({ userId: message.user, text: message.text.trim(), rawText: message.text, place: "channel", channel: message.channel, threadTs: message.threadTs });
    if (reply) {
      await postMessage(message.channel, reply, message.threadTs).catch((error) => console.error("[jarvis] mafia vote reply failed:", error));
    }
  });
}

export function stopGames() {
  stopMafiaTimers();
}
