import { ensureWidget, pushScreen } from "../screen";
import { ArgError, defineTool, plain, str } from "./types";

export default defineTool({
  name: "set_leaderboard",
  description: "Show or update the leaderboard widget on the TV: any title, names and scores (poker stacks, game points...). Highest score first. Puts the leaderboard widget on screen if it is not already.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      rows: {
        type: "array",
        items: { type: "object", properties: { name: { type: "string" }, score: { type: "number" } }, required: ["name", "score"] },
      },
    },
    required: ["title", "rows"],
    additionalProperties: false,
  },
  parse: (raw) => {
    if (!Array.isArray(raw.rows)) throw new ArgError("rows must be a list of {name, score}");
    const rows = raw.rows.slice(0, 20).flatMap((row: unknown) => {
      const item = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      const name = typeof item.name === "string" ? plain(item.name, 40) : "";
      const score = Number(item.score);
      return name && Number.isFinite(score) ? [{ name, score }] : [];
    });
    if (!rows.length) throw new ArgError("rows is empty");
    return { title: str(raw, "title", 60), rows: rows.sort((a, b) => b.score - a.score) };
  },
  run: async ({ title, rows }, ctx) => {
    const result = await pushScreen({ op: "leaderboard", title, rows }, { dryRun: ctx.dryRun });
    if (!result.ok) return result;
    // The data shows once a slot holds the leaderboard widget: the middle, unless one already does.
    return (await ensureWidget("leaderboard", "center", { dryRun: ctx.dryRun })) ?? result;
  },
});
