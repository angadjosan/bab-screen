// The people of the club, for spotting them in the news (lib/club-news.ts): every person in the club's Slack
// workspace, deactivated accounts included, since alumni are still the club's. Read with users.list (the
// users:read scope the spot names already need), at most every ROSTER_TTL_HOURS, and kept in memory.

const ROSTER_TTL_HOURS = 12;
const FAILURE_RETRY_MINUTES = 30;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 500;
const MAX_PAGES = 20;
/** A name is searched for only when it is at least two words and this long, so "Alex" never matches every Alex. */
const MIN_NAME_CHARS = 7;

type SlackMember = {
  id?: string;
  is_bot?: boolean;
  real_name?: string;
  profile?: { real_name?: string };
};
type UsersListResponse = { ok: boolean; error?: string; members?: SlackMember[]; response_metadata?: { next_cursor?: string } };

type Roster = { names: string[]; readAt: number; failedAt: number };
const shared = globalThis as { __babClubRoster?: Roster };
const roster = (shared.__babClubRoster ??= { names: [], readAt: 0, failedAt: 0 });

/** A real person's full name worth searching for: two or more words of letters, long enough to be specific. */
export function searchableName(raw: string | undefined): string | null {
  const name = raw?.replace(/\s+/g, " ").trim() ?? "";
  if (name.length < MIN_NAME_CHARS || !/^\p{L}[\p{L}'’.-]*(?: \p{L}[\p{L}'’.-]*)+$/u.test(name)) return null;
  return name;
}

async function readPage(token: string, cursor: string): Promise<UsersListResponse> {
  const url = `https://slack.com/api/users.list?limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
  return (await response.json()) as UsersListResponse;
}

function memberName(member: SlackMember): string | null {
  if (member.is_bot || member.id === "USLACKBOT") return null;
  return searchableName(member.real_name ?? member.profile?.real_name);
}

async function readRoster(token: string): Promise<string[]> {
  const names = new Set<string>();
  let cursor = "";
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await readPage(token, cursor);
    if (!payload.ok) throw new Error(payload.error ?? "users.list failed");
    const found = (payload.members ?? []).map(memberName).filter((name): name is string => name !== null);
    for (const name of found) names.add(name);
    cursor = payload.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return [...names];
}

/** The club's names, read again when the copy in memory is stale. An empty list when Slack cannot be read. Never throws. */
export async function getRoster(now = Date.now()): Promise<string[]> {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) return [];
  const fresh = now - roster.readAt < ROSTER_TTL_HOURS * 3_600_000;
  const resting = now - roster.failedAt < FAILURE_RETRY_MINUTES * 60_000;
  if (fresh || resting) return roster.names;
  try {
    roster.names = await readRoster(token);
    roster.readAt = now;
  } catch (error) {
    roster.failedAt = now;
    console.warn("[club-news] could not read the Slack roster:", error instanceof Error ? error.message : error);
  }
  return roster.names;
}
