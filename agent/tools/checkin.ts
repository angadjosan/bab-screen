import { addCheckin, checkedInToday } from "../db";
import { defineTool, oneOf, str } from "./types";

export default defineTool({
  name: "checkin",
  description: "Check someone in or out of the clubroom, or list who is in (status=list). Defaults to the person talking.",
  parameters: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["in", "out", "list"] },
      who: { type: "string", description: "Name, if not the person talking" },
    },
    required: ["status"],
    additionalProperties: false,
  },
  parse: (raw) => ({ status: oneOf(raw, "status", ["in", "out", "list"] as const), who: str(raw, "who", 80, { optional: true }) }),
  run: async ({ status, who }, ctx) => {
    if (status === "list") return { in: checkedInToday() };
    const name = who || ctx.who.name || ctx.who.id;
    if (!name) return { ok: false, error: "don't know who to check in; ask their name" };
    addCheckin(name, who ? null : ctx.who.id, status, ctx.who.source);
    return { ok: true, who: name, status, in: checkedInToday() };
  },
});
