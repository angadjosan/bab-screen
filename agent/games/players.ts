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

type SlackUser = { id: string; deleted?: boolean; is_bot?: boolean; name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } };

const isPerson = (user: SlackUser) => !user.deleted && !user.is_bot && user.id !== "USLACKBOT";

/** One entry per name a person goes by, so any of them matches. */
function namesOf(user: SlackUser): Player[] {
  return [user.profile?.display_name, user.real_name, user.profile?.real_name, user.name]
    .map((name) => name?.trim())
    .filter((name): name is string => Boolean(name))
    .map((name) => ({ id: user.id, name }));
}

async function fetchWorkspaceUsers(): Promise<Player[]> {
  const users: Player[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await slackCall<{ members?: SlackUser[]; response_metadata?: { next_cursor?: string } }>("users.list", { limit: 200, cursor }, "GET");
    for (const user of (result.members ?? []).filter(isPerson)) users.push(...namesOf(user));
    cursor = result.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return users;
}

async function workspaceUsers(): Promise<Player[]> {
  if (!config.slackBotToken()) return [];
  if (directory && Date.now() - directory.at < DIRECTORY_TTL_MS) return directory.users;
  let users: Player[];
  try {
    users = await fetchWorkspaceUsers();
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

const firstNameKey = (name: string) => nameKey(name).split(" ")[0];
const uniqueById = (users: Player[]) => [...new Map(users.map((user) => [user.id, user])).values()];
const isSelf = (key: string) => /^(?:me|myself|i)$/.test(key);

/** A workspace user called exactly `key`, else the only one whose first name is `key`. */
async function workspaceMatch(key: string): Promise<Player | null> {
  const users = await workspaceUsers();
  const matches = uniqueById(users.filter((user) => nameKey(user.name) === key));
  const loose = matches.length ? matches : uniqueById(users.filter((user) => firstNameKey(user.name) === key));
  return loose.length === 1 ? loose[0] : null;
}

/** The player a name (not "me") stands for, or null when nobody fits. */
async function playerForName(name: string, key: string, mentioned: Player[]): Promise<Player | null> {
  const byMention = mentioned.find((player) => nameKey(player.name) === key || firstNameKey(player.name) === key);
  if (byMention) return byMention;
  const member = findMemberByName(name);
  if (member) return { id: member.slack_id, name: member.name ?? name };
  const user = await workspaceMatch(key);
  if (user) return { id: user.id, name };
  if (config.dryRun() && !config.slackBotToken()) return { id: `DRY_${key.replace(/\s+/g, "_").toUpperCase()}`, name };
  return null;
}

async function mentionedPlayers(rawText: string | null | undefined, botUserId: string | null | undefined): Promise<Player[]> {
  const ids = [...(rawText ?? "").matchAll(MENTION)].map((match) => match[1]).filter((id) => id !== botUserId);
  const mentioned: Player[] = [];
  for (const id of ids) mentioned.push({ id, name: (await resolveUserName(id)) ?? id });
  return mentioned;
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
  const mentioned = await mentionedPlayers(options.rawText, options.botUserId);
  const unknown: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/^@/, "").trim();
    const key = nameKey(name);
    if (!key) continue;
    const player = isSelf(key) ? options.me ?? null : await playerForName(name, key, mentioned);
    if (player) add(player);
    else unknown.push(name);
  }
  // Every mention counts, also one whose name did not line up with the text ("@someone" when users.info failed).
  for (const player of mentioned) add(player);
  return { players, unknown: mentioned.length ? unknown.filter((name) => nameKey(name) !== "someone") : unknown };
}
