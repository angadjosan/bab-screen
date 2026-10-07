// Pinning a Slack thread to the TV: read it, render names, send pin_thread. Shared by the
// pin_slack_thread tool and the busy-thread scheduler, which must not undo a pin someone asked for.
// Only threads from the channels the TV is meant to show (config.pinChannels()) that Slack says are
// public: a DM, group DM or private channel never goes on the wall, whoever asks.

import { resolveUserName } from "../lib/slack-users";
import { config } from "./config";
import { ensureWidget, pushScreen, type PinnedThread, type ScreenResult } from "./screen";
import { permalink, slackCall, threadReplies, type SlackMsg } from "./slack-api";
import { plain } from "./tools/types";

export type Pin = { channel: string; ts: string; by: "scheduler" | "request"; at: number };

let pinned: Pin | null = null;

export const currentPin = () => pinned;

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** Slack markup to plain text, mentions as @Name. */
export async function slackText(text: string | undefined, max: number): Promise<string> {
  let out = text ?? "";
  const ids = [...new Set([...out.matchAll(MENTION)].map((match) => match[1]))];
  const names = await Promise.all(ids.map((id) => resolveUserName(id)));
  ids.forEach((id, index) => {
    out = out.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, "g"), names[index] ? `@${names[index]}` : "@someone");
  });
  out = out
    .replace(/<(?:https?|mailto):[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<((?:https?|mailto):[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<![^>|]*(?:\|([^>]+))?>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  return plain(out, max, true);
}

const author = async (message: SlackMsg) => (message.user ? (await resolveUserName(message.user)) ?? "someone" : "a bot");

export async function buildThread(channel: string, ts: string, maxReplies = 6): Promise<PinnedThread> {
  const messages = await threadReplies(channel, ts, 100);
  const parent = messages.find((message) => message.ts === ts) ?? messages[0];
  if (!parent) throw new Error("thread_not_found");
  const replies = messages.filter((message) => message.ts !== parent.ts && !message.subtype).slice(-maxReplies);
  return {
    channel,
    ts,
    author: await author(parent),
    text: await slackText(parent.text, 400),
    replies: await Promise.all(replies.map(async (reply) => ({ author: await author(reply), text: await slackText(reply.text, 200) }))),
    permalink: (await permalink(channel, ts)) ?? undefined,
  };
}

type ChannelInfo = { is_channel?: boolean; is_group?: boolean; is_private?: boolean; is_im?: boolean; is_mpim?: boolean; is_archived?: boolean };

const CHANNEL_CHECK_MS = 10 * 60_000;
const publicChannels = new Map<string, { isPublic: boolean; at: number }>();

/** Null when a thread in `channel` may go on the TV; otherwise why not (never the thread's text). */
export async function pinRefusal(channel: string): Promise<string | null> {
  if (!config.pinChannels().includes(channel)) return "that channel isn't one the TV shows (SLACK_CHANNEL_ID or JARVIS_PIN_CHANNELS)";
  let known = publicChannels.get(channel);
  if (!known || Date.now() - known.at > CHANNEL_CHECK_MS) {
    try {
      const info = (await slackCall<{ channel?: ChannelInfo }>("conversations.info", { channel }, "GET")).channel;
      const isPublic = Boolean(info && info.is_channel !== false && !info.is_group && !info.is_private && !info.is_im && !info.is_mpim && !info.is_archived);
      known = { isPublic, at: Date.now() };
      publicChannels.set(channel, known);
    } catch {
      return "couldn't check with Slack that the channel is public";
    }
  }
  return known.isPublic ? null : "that channel isn't public, so it stays off the TV";
}

export async function pinThread(channel: string, ts: string, by: Pin["by"], dryRun?: boolean): Promise<ScreenResult & { thread?: PinnedThread }> {
  const refusal = await pinRefusal(channel);
  if (refusal) return { ok: false, status: null, error: refusal };
  const thread = await buildThread(channel, ts);
  const result = await pushScreen({ op: "pin_thread", thread }, { dryRun });
  if (!result.ok) return { ...result, thread };
  pinned = { channel, ts, by, at: pinned?.channel === channel && pinned.ts === ts ? pinned.at : Date.now() };
  // Stored data only shows once a slot holds the widget: the right column's main slot, unless one already does.
  const placed = await ensureWidget("pinned_thread", "side", { dryRun });
  return placed && !placed.ok ? { ...placed, thread } : { ...result, thread };
}

export async function unpinThread(dryRun?: boolean): Promise<ScreenResult> {
  const result = await pushScreen({ op: "unpin_thread" }, { dryRun });
  if (result.ok) pinned = null;
  return result;
}

/** Slack message links (https://x.slack.com/archives/C123/p1700000000123456) to channel + ts. */
export function parseThreadLink(link: string): { channel: string; ts: string } | null {
  const match = link.match(/\/archives\/([CGD][A-Z0-9]+)\/p(\d{10})(\d{6})/);
  if (!match) return null;
  const thread = link.match(/[?&]thread_ts=(\d+\.\d+)/);
  return { channel: match[1], ts: thread ? thread[1] : `${match[2]}.${match[3]}` };
}
