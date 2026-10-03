import { pushScreen } from "../screen";
import { bool, defineTool, int, str } from "./types";

export default defineTool({
  name: "overlay_message",
  description: "Show a banner message across the TV for a while, or clear every banner and card (clear=true).",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Short banner text, under 120 characters" },
      seconds: { type: "integer", description: "How long to show it, 5-600; default 30" },
      clear: { type: "boolean", description: "true to clear all overlays instead" },
    },
    additionalProperties: false,
  },
  parse: (raw) => ({ clear: bool(raw, "clear"), text: str(raw, "text", 140, { optional: true }), seconds: int(raw, "seconds", 5, 600, 30) }),
  run: ({ clear, text, seconds }, ctx) => {
    if (clear) return pushScreen({ op: "clear_overlays" }, { dryRun: ctx.dryRun });
    if (!text) return Promise.resolve({ ok: false, error: "text is required unless clear is true" });
    return pushScreen({ op: "banner", text, ttlSeconds: seconds }, { dryRun: ctx.dryRun });
  },
});
