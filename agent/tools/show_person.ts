import { findVisitors, touchVisitor } from "../db";
import { pushScreen } from "../screen";
import { lastLookup } from "./lookup_person";
import { bool, defineTool, int, str } from "./types";

export default defineTool({
  name: "show_person",
  description: "Put a person card on the TV (name, headline, summary; links and photo come from lookup_person). If lookup_person said ambiguous, only call this after the person confirmed who it is, with confirmed=true.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      headline: { type: "string", description: "Role and organisation" },
      summary: { type: "string", description: "One or two sentences" },
      confirmed: { type: "boolean", description: "true once someone in the room confirmed who this is" },
      seconds: { type: "integer", description: "How long to show it, 10-600; default 60" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  parse: (raw) => ({
    name: str(raw, "name", 80),
    headline: str(raw, "headline", 80, { optional: true }),
    summary: str(raw, "summary", 260, { optional: true }),
    confirmed: bool(raw, "confirmed"),
    seconds: int(raw, "seconds", 10, 600, 60),
  }),
  run: async ({ name, headline, summary, confirmed, seconds }, ctx) => {
    const lookup = lastLookup(name);
    if (lookup?.ambiguous && !confirmed) {
      return { ok: false, error: "The lookup was not sure who this is. Ask the room to confirm first, then call show_person with confirmed=true." };
    }
    // The card's links and photo come from what the lookup found, not from the model.
    const known = findVisitors(name).find((row) => !headline || row.headline === headline) ?? null;
    const links = known ? (JSON.parse(known.links || "[]") as { label: string; url: string }[]) : [];
    if (known) touchVisitor(known.id);
    return pushScreen(
      {
        op: "person",
        card: {
          name,
          ...(headline || known?.headline ? { headline: headline || known?.headline || undefined } : {}),
          ...(summary || known?.summary ? { summary: summary || known?.summary || undefined } : {}),
          ...(links.length ? { links } : {}),
          ...(known?.image_url ? { imageUrl: known.image_url } : {}),
        },
        ttlSeconds: seconds,
      },
      { dryRun: ctx.dryRun },
    );
  },
});
