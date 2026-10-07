import { config } from "../config";
import { postMessage } from "../slack-api";
import { defineTool, oneOf, str } from "./types";

export default defineTool({
  name: "reply",
  description: "Post a message in Slack: in the conversation you were asked in (where=here), or in the main club channel (where=main). Your final answer is already posted where you were asked, so use this only for an extra message or the main channel.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string" },
      where: { type: "string", enum: ["here", "main"] },
    },
    required: ["text"],
    additionalProperties: false,
  },
  parse: (raw) => ({ text: str(raw, "text", 2_000, { multiline: true }), where: oneOf(raw, "where", ["here", "main"] as const, "here") }),
  run: async ({ text, where }, ctx) => {
    const channel = where === "main" || !ctx.channel ? config.slackChannel() : ctx.channel;
    if (!channel) return { ok: false, error: "no Slack channel to post in" };
    const threadTs = where === "here" && channel === ctx.channel ? ctx.threadTs : null;
    if (ctx.dryRun) {
      ctx.dryRunLog.push(`slack ${channel}: ${text}`);
    } else {
      await postMessage(channel, text, threadTs);
    }
    if (channel === ctx.channel) ctx.replied.push(text);
    return { ok: true, channel, threaded: Boolean(threadTs) };
  },
});
