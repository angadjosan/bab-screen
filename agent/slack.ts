// The Slack listener: @slack/bolt in Socket Mode (no public URL). @mentions and DMs run a turn and
// get the answer in a thread. Button clicks on the focus mode question are answered here too. Every channel message (message.channels) also goes to the handlers
// registered with onChannelMessage(): the scheduler's busy-thread watcher, and agent/feeds.ts, which
// nudges the Next app to re-read the spots, chumming, quotes and songs channels when they change.

import { App, LogLevel } from "@slack/bolt";
import { FOCUS_MUSIC_ACTION, FOCUS_MUSIC_CHOICES, chooseFocusMusic, looksLikeCommand, parseCommand, type FocusMusicChoice } from "../lib/commands";
import { looksLikeJamTrigger } from "../lib/jam";
import { resolveUserName } from "../lib/slack-users";
import { findTrackLinks } from "../lib/spotify";
import { config } from "./config";
import { upsertMember } from "./db";
import { slackText } from "./threads";
import { runTurn } from "./turn";
import { postMessage } from "./slack-api";

export type ChannelMessage = {
  channel: string;
  ts: string;
  threadTs: string | null;
  user: string | null;
  botId: string | null;
  subtype: string | null;
  text: string;
  /** True when the message @mentions Jarvis (it is also handled as a request). */
  mentionsBot: boolean;
  raw: Record<string, unknown>;
};

export type ChannelHandler = (message: ChannelMessage) => void | Promise<void>;

const handlers: Array<{ name: string; channel: string | null; handler: ChannelHandler }> = [];

/** Routes channel messages (optionally only one channel's) to `handler`. Errors are logged, never thrown. */
export function onChannelMessage(name: string, handler: ChannelHandler, channel: string | null = null) {
  handlers.push({ name, channel, handler });
}

async function dispatch(message: ChannelMessage) {
  for (const entry of handlers) {
    if (entry.channel && entry.channel !== message.channel) continue;
    try {
      await entry.handler(message);
    } catch (error) {
      console.error(`[jarvis] channel handler ${entry.name} failed:`, error);
    }
  }
}

let app: App | null = null;
let botUserId: string | null = null;
let connected = false;

export const slackStatus = () => ({ listening: connected, botUserId });

/**
 * A mention in the songs channel with a track link, "jam" or a command (focus, pause, volume 20, ...) is
 * the Next app's: lib/songs.ts reads it from the channel and queues it, shows the Jam QR, or runs the
 * command (lib/commands.ts). Running a turn as well would do it twice.
 */
export function songsChannelOwns(
  event: { channel: string; text?: string; thread_ts?: string; ts?: string },
  songsChannel = config.songsChannel(),
  bot = botUserId,
): boolean {
  if (!songsChannel || event.channel !== songsChannel || !event.text) return false;
  if (event.thread_ts && event.thread_ts !== event.ts) return false; // thread replies are not song requests
  if (findTrackLinks(event.text).length > 0 || looksLikeJamTrigger(event.text)) return true;
  return looksLikeCommand(event.text) && parseCommand(event.text, bot) !== null;
}

/** "focus_music:dim" → "dim"; null for any other action. */
export function focusMusicChoice(actionId: string): FocusMusicChoice | null {
  if (!actionId.startsWith(FOCUS_MUSIC_ACTION)) return null;
  const choice = actionId.slice(FOCUS_MUSIC_ACTION.length);
  return (FOCUS_MUSIC_CHOICES as readonly string[]).includes(choice) ? (choice as FocusMusicChoice) : null;
}

async function handleRequest(event: { user?: string; text?: string; channel: string; ts: string; thread_ts?: string }, place: "dm" | "channel") {
  if (!event.user || !event.text) return;
  if (place === "channel" && songsChannelOwns(event)) return;
  const name = await resolveUserName(event.user);
  upsertMember(event.user, name);
  const text = await slackText(event.text.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "g"), "").trim(), 2_000);
  // In a channel the answer goes in a thread under the mention; in a DM, in the same thread if there is one.
  const threadTs = event.thread_ts ?? (place === "channel" ? event.ts : null);
  const result = await runTurn({ text, rawText: event.text, source: "slack", userId: event.user, userName: name, channel: event.channel, threadTs, place });
  if (result.reply && !result.alreadyReplied) {
    try {
      await postMessage(event.channel, result.reply, threadTs);
    } catch (error) {
      console.error("[jarvis] Slack reply failed:", error);
    }
  }
}

const textField = (raw: Record<string, unknown>, key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : null);

function channelMessage(raw: Record<string, unknown>): ChannelMessage {
  const text = textField(raw, "text") ?? "";
  return {
    channel: String(raw.channel ?? ""),
    ts: String(raw.ts ?? ""),
    threadTs: textField(raw, "thread_ts"),
    user: textField(raw, "user"),
    botId: textField(raw, "bot_id"),
    subtype: textField(raw, "subtype"),
    text,
    mentionsBot: Boolean(botUserId && text.includes(`<@${botUserId}`)),
    raw,
  };
}

/** Starts Socket Mode if both tokens are set. Returns false (and logs why) otherwise. */
export async function startSlack(): Promise<boolean> {
  const appToken = config.slackAppToken();
  const botToken = config.slackBotToken();
  if (!appToken || !botToken) {
    console.warn(`[jarvis] Slack listener off: ${!appToken ? "SLACK_APP_TOKEN (xapp-)" : "SLACK_BOT_TOKEN"} is not set.`);
    return false;
  }
  if (!appToken.startsWith("xapp-")) {
    console.warn("[jarvis] Slack listener off: SLACK_APP_TOKEN must be an app-level token (xapp-...) with connections:write.");
    return false;
  }

  app = new App({ token: botToken, appToken, socketMode: true, logLevel: LogLevel.WARN });

  app.event("app_mention", async ({ event }) => {
    await handleRequest(event as { user?: string; text?: string; channel: string; ts: string; thread_ts?: string }, "channel");
  });

  app.message(async ({ message }) => {
    const incoming = channelMessage(message as unknown as Record<string, unknown>);
    if (incoming.user && incoming.user === botUserId) return;
    if (incoming.raw.channel_type === "im") {
      // Only plain messages typed by a person; edits, joins and bot posts are not requests.
      if (!incoming.subtype && !incoming.botId && incoming.user) await handleRequest({ user: incoming.user, text: incoming.text, channel: incoming.channel, ts: incoming.ts, thread_ts: incoming.threadTs ?? undefined }, "dm");
      return;
    }
    // Channel messages: requests arrive as app_mention, so here they are only routed to handlers.
    await dispatch(incoming);
  });

  // The buttons under "Focus mode is on. What should the music do?" (lib/commands.ts). Slack only sends
  // these when Interactivity is turned on for the app; in Socket Mode it needs no request URL.
  app.action(new RegExp(`^${FOCUS_MUSIC_ACTION}`), async ({ ack, action, respond }) => {
    await ack();
    const choice = "action_id" in action ? focusMusicChoice(action.action_id) : null;
    if (!choice) return;
    await respond({ replace_original: true, text: await chooseFocusMusic(choice) });
  });

  app.error(async (error) => {
    console.error("[jarvis] Slack error:", error);
  });

  try {
    await app.start();
    const auth = await app.client.auth.test();
    botUserId = (auth.user_id as string | undefined) ?? null;
    connected = true;
    console.log(`[jarvis] Slack listener connected (Socket Mode) as ${auth.user ?? botUserId}.`);
    return true;
  } catch (error) {
    console.error("[jarvis] Slack listener failed to start:", error instanceof Error ? error.message : error);
    app = null;
    return false;
  }
}

export async function stopSlack() {
  connected = false;
  await app?.stop().catch(() => undefined);
  app = null;
}
