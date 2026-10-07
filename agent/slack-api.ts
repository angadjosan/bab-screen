// Small Slack Web API client for the agent (posts, thread reads, permalinks). The Socket Mode
// listener is in agent/slack.ts; this works with the bot token alone, so tools and the scheduler
// run even when the listener is not connected.

import { config } from "./config";

export class SlackError extends Error {
  constructor(readonly code: string) {
    super(`Slack API error: ${code}`);
  }
}

const TIMEOUT_MS = 10_000;

export async function slackCall<T>(method: string, body: Record<string, unknown>, httpMethod: "GET" | "POST" = "POST"): Promise<T> {
  const token = config.slackBotToken();
  if (!token) throw new SlackError("token_missing");
  const url = new URL(`https://slack.com/api/${method}`);
  let init: RequestInit = { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (httpMethod === "GET") {
    for (const [key, value] of Object.entries(body)) if (value !== undefined) url.searchParams.set(key, String(value));
  } else {
    init = { ...init, method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
  }
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new SlackError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network_error");
  }
  if (response.status === 429) throw new SlackError("rate_limited");
  if (!response.ok) throw new SlackError(`http_${response.status}`);
  const payload = (await response.json()) as T & { ok: boolean; error?: string };
  if (!payload.ok) throw new SlackError(payload.error ?? "unknown");
  return payload;
}

export type SlackMsg = { ts?: string; thread_ts?: string; user?: string; bot_id?: string; subtype?: string; text?: string; reply_count?: number; latest_reply?: string };

export async function postMessage(channel: string, text: string, threadTs?: string | null): Promise<{ ts: string | null }> {
  if (config.dryRun()) {
    console.log(`[jarvis] dry run: slack post to ${channel}${threadTs ? ` (thread ${threadTs})` : ""}: ${text}`);
    return { ts: null };
  }
  const result = await slackCall<{ ts?: string }>("chat.postMessage", { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false });
  return { ts: result.ts ?? null };
}

export async function threadReplies(channel: string, ts: string, limit = 50): Promise<SlackMsg[]> {
  const result = await slackCall<{ messages?: SlackMsg[] }>("conversations.replies", { channel, ts, limit }, "GET");
  return result.messages ?? [];
}

export async function history(channel: string, options: { oldest?: number; limit?: number } = {}): Promise<SlackMsg[]> {
  const result = await slackCall<{ messages?: SlackMsg[] }>(
    "conversations.history",
    { channel, limit: options.limit ?? 50, ...(options.oldest ? { oldest: (options.oldest / 1000).toFixed(6) } : {}) },
    "GET",
  );
  return result.messages ?? [];
}

export async function permalink(channel: string, ts: string): Promise<string | null> {
  try {
    const result = await slackCall<{ permalink?: string }>("chat.getPermalink", { channel, message_ts: ts }, "GET");
    return result.permalink ?? null;
  } catch {
    return null;
  }
}

const dmChannels = new Map<string, string>();

/** A direct message from the bot to one person (conversations.open, needs im:write; then chat.postMessage). */
export async function dmUser(userId: string, text: string): Promise<{ ts: string | null }> {
  if (config.dryRun()) {
    console.log(`[jarvis] dry run: slack DM to ${userId}: ${text}`);
    return { ts: null };
  }
  let channel = dmChannels.get(userId);
  if (!channel) {
    const opened = await slackCall<{ channel?: { id?: string } }>("conversations.open", { users: userId });
    channel = opened.channel?.id;
    if (!channel) throw new SlackError("no_dm_channel");
    dmChannels.set(userId, channel);
  }
  return postMessage(channel, text);
}
