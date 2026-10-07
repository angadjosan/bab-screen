import { config } from "../config";
import { parseThreadLink, pinThread, unpinThread } from "../threads";
import { bool, defineTool, str } from "./types";

export default defineTool({
  name: "pin_slack_thread",
  description: "Pin a Slack thread to the TV (its first message and latest replies), or unpin the current one (unpin=true). Puts the pinned-thread widget on screen if it is not already. Give a Slack message link, or nothing to pin the thread you were asked in.",
  parameters: {
    type: "object",
    properties: {
      link: { type: "string", description: "Slack message link" },
      unpin: { type: "boolean" },
    },
    additionalProperties: false,
  },
  parse: (raw) => ({ link: str(raw, "link", 300, { optional: true }), unpin: bool(raw, "unpin") }),
  run: async ({ link, unpin }, ctx) => {
    if (unpin) return unpinThread(ctx.dryRun);
    const target = link ? parseThreadLink(link) : ctx.channel && ctx.threadTs ? { channel: ctx.channel, ts: ctx.threadTs } : null;
    if (!target) return { ok: false, error: "need a Slack message link (or ask me inside the thread)" };
    if (!config.slackBotToken()) return { ok: false, error: "SLACK_BOT_TOKEN is not set" };
    const result = await pinThread(target.channel, target.ts, "request", ctx.dryRun);
    return { ok: result.ok, error: result.error, pinned: result.thread ? { author: result.thread.author, text: result.thread.text, replies: result.thread.replies?.length ?? 0 } : null };
  },
});
