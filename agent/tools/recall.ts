import { findMemberByName, findMemories, findVisitors, getMember } from "../db";
import { defineTool, str } from "./types";

export default defineTool({
  name: "recall",
  description: "Look up what you remember about a person (member or past visitor), or search memories for a word.",
  parameters: {
    type: "object",
    properties: {
      about: { type: "string", description: "Person's name, or \"me\"" },
      query: { type: "string", description: "Word or phrase to search for" },
    },
    additionalProperties: false,
  },
  parse: (raw) => ({ about: str(raw, "about", 80, { optional: true }), query: str(raw, "query", 80, { optional: true }) }),
  run: async ({ about, query }, ctx) => {
    const self = /^(me|myself|i)$/i.test(about);
    const name = self ? ctx.who.name ?? "" : about;
    const member = self && ctx.who.id ? getMember(ctx.who.id) : name ? findMemberByName(name) : null;
    const memories = findMemories({ about: name ? [name] : [], query, limit: 15 });
    const visitors = name ? findVisitors(name, 3).map((v) => ({ name: v.name, headline: v.headline, summary: v.summary, brought_by: v.brought_by, last_seen: new Date(v.last_seen).toISOString(), confidence: v.confidence })) : [];
    return { member, memories: memories.map((m) => ({ about: m.about, kind: m.kind, text: m.text, by: m.created_by, at: new Date(m.created_at).toISOString() })), visitors };
  },
});
