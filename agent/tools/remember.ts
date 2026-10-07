import { addMemory, appendMemberField, findMemberByName, getMember } from "../db";
import { defineTool, oneOf, str } from "./types";

const KINDS = ["fact", "interest", "joke"] as const;

export default defineTool({
  name: "remember",
  description: "Save something worth remembering about a member, a visitor or the club: a fact, an interest or a running joke. Use \"me\" for the person talking to you.",
  parameters: {
    type: "object",
    properties: {
      about: { type: "string", description: "Person's name, \"me\", or \"club\"" },
      text: { type: "string", description: "The thing to remember, one sentence" },
      kind: { type: "string", enum: [...KINDS] },
    },
    required: ["about", "text"],
    additionalProperties: false,
  },
  parse: (raw) => ({ about: str(raw, "about", 80), text: str(raw, "text", 300), kind: oneOf(raw, "kind", KINDS, "fact") }),
  run: async ({ about, text, kind }, ctx) => {
    const self = /^(me|myself|i)$/i.test(about);
    const name = self ? ctx.who.name ?? ctx.who.id ?? "unknown" : about;
    const id = addMemory(name, kind, text, ctx.who.name ?? ctx.who.id);
    // Interests and running jokes also go on the member's row, which every prompt about them carries.
    const member = self && ctx.who.id ? getMember(ctx.who.id) : findMemberByName(name);
    if (member && kind !== "fact") appendMemberField(member.slack_id, kind === "interest" ? "interests" : "running_jokes", text);
    return { ok: true, id, about: name, kind };
  },
});
