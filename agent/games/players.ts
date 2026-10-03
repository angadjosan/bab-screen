// Turning "@Alice @Bob @Carol" into Slack user ids, so Mafia can DM each player. The best source is the
// message as Slack sent it (<@U123> mentions); failing that, names are matched against members who have talked to
// Jarvis, then the workspace's user list (users.list, the users:read scope), cached for ten minutes.

import { resolveUserName } from "../../lib/slack-users";
import { config } from "../config";
import { findMemberByName, nameKey } from "../db";
import { slackCall } from "../slack-api";

export type Player = { id: string; name: string };

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const DIRECTORY_TTL_MS = 10 * 60_000;

let directory: { at: number; users: Player[] } | null = null;

async function workspaceUsers(): Promise<Player[]> {
  if (!config.slackBotToken()) return [];
  if (directory && Date.now() - directory.at < DIRECTORY_TTL_MS) return directory.users;
  type User = { id: string; deleted?: boolean; is_bot?: boolean; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };
  const users: Player[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < 10; page += 1) {
      const result = await slackCall<{ members?: User[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: 200, cursor }, "GET");
      for (const user of result.members ?? []) {
        if (user.deleted || user.is_bot || user.id === "USLACKBOT") continue;
        for (const name of [user.profile?.display_name, user.real_name, user.profile?.real_name, user.name]) {
          if (name?.trim()) users.push({ id: user.id, name: name.trim() });
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
  } catch (error) {
    console.warn("[jarvis] users.list failed:", error instanceof Error ? error.message : error);
    return directory?.users ?? [];
  }
  directory = { at: Date.now(), users };
  return users;
}

/** Names from a command: "@Alice Smith @Bob", "alice, bob and carol", or "alice bob carol". */
export function splitNames(text: string): string[] {
  const cleaned = text.replace(MENTION, " ").trim();
  const parts = cleaned.includes("@") ? cleaned.split("@").slice(cleaned.startsWith("@") ? 1 : 0) : /[,;&]|\band\b/.test(cleaned) ? cleaned.split(/\s*(?:[,;&]|\band\b)\s*/) : cleaned.split(/\s+/);
  return parts.map((part) => part.replace(/^(?:and|with)\s+/i, "").replace(/[,;.!?]+$/, "").trim()).filter(Boolean);
}

/**
 * Players for a game. Mentions in `rawText` come first (exact ids); then each name: "me" is the person asking,
 * else a member or workspace user with that name. Unknown names come back in `unknown`. In dry-run mode with no
 * Slack token, unknown names get a stand-in id so the game can be tried offline.
 */
export async function resolvePlayers(names: string[], options: { rawText?: string | null; me?: Player | null; botUserId?: string | null }): Promise<{ players: Player[]; unknown: string[] }> {
  const players: Player[] = [];
  const add = (player: Player) => {
    if (!players.some((other) => other.id === player.id)) players.push(player);
  };
  const ids = [...(options.rawText ?? "").matchAll(MENTION)].map((match) => match[1]).filter((id) => id !== options.botUserId);
  const mentioned: Player[] = [];
  for (const id of ids) mentioned.push({ id, name: (await resolveUserName(id)) ?? id });
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/^@/, "").trim();
    const key = nameKey(name);
    if (!key) continue;
    if (/^(?:me|myself|i)$/.test(key)) {
      if (options.me) add(options.me);
      else unknown.push(name);
      continue;
    }
    const byMention = mentioned.find((player) => nameKey(player.name) === key || nameKey(player.name).split(" ")[0] === key);
    if (byMention) {
      add(byMention);
      continue;
    }
    const member = findMemberByName(name);
    if (member) {
      add({ id: member.slack_id, name: member.name ?? name });
      continue;
    }
    const users = await workspaceUsers();
    const matches = [...new Map(users.filter((user) => nameKey(user.name) === key).map((user) => [user.id, user])).values()];
    const loose = matches.length ? matches : [...new Map(users.filter((user) => nameKey(user.name).split(" ")[0] === key).map((user) => [user.id, user])).values()];
    if (loose.length === 1) {
      add({ id: loose[0].id, name });
      continue;
    }
    if (config.dryRun() && !config.slackBotToken()) {
      add({ id: `DRY_${key.replace(/\s+/g, "_").toUpperCase()}`, name });
      continue;
    }
    unknown.push(name);
  }
  // Every mention counts, also one whose name did not line up with the text ("@someone" when users.info failed).
  for (const player of mentioned) add(player);
  return { players, unknown: mentioned.length ? unknown.filter((name) => nameKey(name) !== "someone") : unknown };
}
