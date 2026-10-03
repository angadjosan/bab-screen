// The fast path: common commands handled with no model call. parseRule() is pure (tested in
// agent/selftest.ts); anything it does not recognise goes to the LLM, or gets a polite "rules only"
// answer when there is no key or the day's spend cap is reached.

import { presetName, pushScreen, type Preset } from "./screen";
import { playback, queueTrack, type PlaybackAction } from "./music";
import { addCheckin, addMemory, appendMemberField, findMemories, getMember, logEvent } from "./db";
import type { TurnContext } from "./tools/types";
import { parseGameCommand, runGameCommand, type GameCommand } from "./games";

export type Rule =
  | { kind: "queue"; query: string }
  | { kind: "playback"; action: Exclude<PlaybackAction, "status">; volume?: number }
  | { kind: "preset"; preset: Preset }
  | { kind: "checkin"; status: "in" | "out" }
  | { kind: "interests"; items: string[] }
  | { kind: "game"; command: GameCommand };

/**
 * "my interests: zk, MEV, F1", "my interests are zk and F1", "interests: ...": the list, each item
 * cut to one short line. Looser phrasings ("I'm into F1") go to the model's remember tool.
 */
const INTERESTS = /^(?:my interests?(?:\s+(?:are|is|include))?\s*[:-]?|interests?\s*:)\s*(.+)$/i;
const MAX_INTEREST_ITEMS = 12;
const INTEREST_MAX_CHARS = 60;

/** Lower case, wake word, Slack mentions, politeness and end punctuation removed. */
export function normalize(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+(?:\|[^>]*)?>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:(?:hey|hi|ok|okay|yo)\s+)?jarvis\b[\s,:.!-]*/i, "")
    .replace(/^(?:please|pls|can you|could you)\s+/i, "")
    .replace(/[.!?\s]+$/, "")
    .replace(/[\s,]+(?:please|pls|thanks|thank you|jarvis)$/i, "")
    .replace(/[.!?\s]+$/, "")
    .trim();
}

const PLAYBACK: Array<[RegExp, Exclude<PlaybackAction, "status" | "volume_set">]> = [
  [/^(?:skip|next|next (?:song|track)|skip (?:it|this|this song|this track|the song|song|track))$/, "next"],
  [/^(?:previous|previous (?:song|track)|last song|go back a song)$/, "previous"],
  [/^(?:pause|stop|pause (?:it|the music|music|spotify)|stop (?:the )?music|stop spotify)$/, "pause"],
  [/^(?:play|resume|unpause|play (?:it|the music|music)|resume (?:the )?music|start (?:the )?music)$/, "play"],
  [/^(?:volume up|louder|turn it up|turn (?:the )?music up|turn up (?:the )?(?:music|volume)|crank it|pump it up)$/, "volume_up"],
  [/^(?:volume down|quieter|softer|turn it down|turn (?:the )?music down|turn down (?:the )?(?:music|volume))$/, "volume_down"],
];

export function parseRule(input: string): Rule | null {
  const raw = normalize(input);
  const text = raw.toLowerCase();
  if (!text) return null;

  for (const [pattern, action] of PLAYBACK) if (pattern.test(text)) return { kind: "playback", action };

  const volume = text.match(/^(?:set (?:the )?)?volume (?:to |at )?(\d{1,3})\s*%?$/);
  if (volume) return { kind: "playback", action: "volume_set", volume: Math.min(100, Number(volume[1])) };

  const preset = text.match(/^(?:preset|layout|switch to|go to|change to|put on)\s+(.+?)(?:\s+(?:mode|preset|layout))?$/) ?? text.match(/^(.+?)\s+(?:mode|preset)$/);
  if (preset) {
    const name = presetName(preset[1]);
    if (name) return { kind: "preset", preset: name };
  }

  // "queue X" takes anything after it; "add X" only with "to the queue". Original case for the search.
  const queue = raw.match(/^(?:queue up|queue)\s+(.+?)(?:\s+(?:to|in|on) (?:the )?queue)?$/i) ?? raw.match(/^add\s+(.+?)\s+to (?:the )?queue$/i);
  if (queue && queue[1].trim()) return { kind: "queue", query: queue[1].trim() };

  // Original case, so "MEV" stays "MEV". A question ("my interests?") is for the model.
  const interests = /\?\s*$/.test(input) ? null : raw.match(INTERESTS);
  if (interests) {
    const items = [...new Map(
      interests[1]
        .split(/\s*(?:[,;•]|\s-\s|\band\b)\s*/i) // normalize() has already turned newlines into spaces
        .map((item) => item.replace(/^[\s"'*_-]+|[\s"'*_.!-]+$/g, "").slice(0, INTEREST_MAX_CHARS).trim())
        .filter(Boolean)
        .map((item) => [item.toLowerCase(), item] as const),
    ).values()].slice(0, MAX_INTEREST_ITEMS);
    if (items.length) return { kind: "interests", items };
  }

  if (/^(?:i'?m here|i am here|checking in|check (?:me )?in|i'?m in(?: the office)?|i'?ve arrived)$/.test(text.replace(/’/g, "'"))) return { kind: "checkin", status: "in" };
  if (/^(?:i'?m out|i'?m leaving|heading out|checking out|i'?m heading out)$/.test(text.replace(/’/g, "'"))) return { kind: "checkin", status: "out" };

  // Poker and Mafia (agent/games): original case, so names stay as typed.
  const game = parseGameCommand(raw);
  if (game) return { kind: "game", command: game };

  return null;
}

/** Runs a recognised command and returns what to tell the person. Logged like a tool call. */
export async function runRule(rule: Rule, ctx: TurnContext): Promise<{ ok: boolean; reply: string }> {
  let outcome: { ok: boolean; reply: string };
  if (rule.kind === "queue") {
    const result = await queueTrack(rule.query, { dryRun: ctx.dryRun });
    outcome = { ok: result.ok, reply: result.message };
  } else if (rule.kind === "playback") {
    const result = await playback(rule.action, { volume: rule.volume, dryRun: ctx.dryRun });
    outcome = { ok: result.ok, reply: result.message };
  } else if (rule.kind === "preset") {
    const result = await pushScreen({ op: "set_preset", preset: rule.preset }, { dryRun: ctx.dryRun });
    outcome = { ok: result.ok, reply: result.ok ? `Screen: ${rule.preset.replace("_", " ")}.` : `The TV said no: ${result.error ?? "unknown error"}.` };
  } else if (rule.kind === "game") {
    outcome = await runGameCommand(rule.command, ctx);
  } else if (rule.kind === "interests") {
    // Stored like the remember tool's kind=interest, one memory each, so the feed can lean on them.
    const who = ctx.who.name ?? ctx.who.id;
    if (!who) {
      outcome = { ok: false, reply: "Who's this? Tell me your name first and I'll remember your interests." };
    } else {
      const known = new Set(findMemories({ about: [who], limit: 500 }).filter((row) => row.kind === "interest").map((row) => row.text.toLowerCase()));
      const member = ctx.who.id ? getMember(ctx.who.id) : null;
      for (const item of rule.items) {
        if (!known.has(item.toLowerCase())) addMemory(who, "interest", item, who);
        if (member) appendMemberField(member.slack_id, "interests", item);
      }
      outcome = { ok: true, reply: `Noted, ${who}: ${rule.items.join(", ")}. The feed will lean that way while you're in.` };
    }
  } else {
    const who = ctx.who.name ?? ctx.who.id;
    if (!who) {
      outcome = { ok: false, reply: "Who's this? Tell me your name and I'll check you in." };
    } else {
      addCheckin(who, ctx.who.id, rule.status, ctx.who.source);
      outcome = { ok: true, reply: rule.status === "in" ? `Checked in, ${who}.` : `Checked out. Later, ${who}.` };
    }
  }
  logEvent(ctx.who, "rule", rule.kind, rule, outcome.ok, outcome.reply);
  return outcome;
}
