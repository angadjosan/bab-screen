import { speak } from "../speech";
import { defineTool, str } from "./types";

export default defineTool({
  name: "say",
  description: "Say something out loud in the clubroom (the music dips while you talk). One or two short sentences.",
  parameters: {
    type: "object",
    properties: { text: { type: "string", description: "What to say, plain words" } },
    required: ["text"],
    additionalProperties: false,
  },
  parse: (raw) => ({ text: str(raw, "text", 400) }),
  run: async ({ text }, ctx) => {
    const result = await speak(text, { dryRun: ctx.dryRun });
    ctx.spoken.push(result.said);
    return { ok: Boolean(result.said), said: result.said };
  },
});
