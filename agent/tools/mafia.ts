import { runGameCommand } from "../games";
import { defineTool, int, oneOf, str } from "./types";

const ACTIONS = ["start", "status", "next", "end"] as const;

export default defineTool({
  name: "mafia",
  description:
    "Mafia on the TV with roles by Slack DM. start with 4-16 players (@mentions or names; 'me' for the person asking); status for the public state (never roles); next to end the current phase early; end to call the game off. Night actions and votes are handled by Jarvis directly, not by you.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      players: { type: "string", description: "start only: the players, e.g. '@Alice @Bob @Carol @Dan'" },
      night_seconds: { type: "number", description: "start only, default 60" },
      day_seconds: { type: "number", description: "start only, default 150" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const action = oneOf(raw, "action", ACTIONS);
    if (action !== "start") return { action };
    return {
      action,
      players: str(raw, "players", 800, { optional: true }),
      nightSeconds: int(raw, "night_seconds", 20, 600, 60),
      daySeconds: int(raw, "day_seconds", 20, 600, 150),
    };
  },
  run: async (args, ctx) => {
    if (args.action !== "start") return runGameCommand({ game: "mafia", action: args.action }, ctx);
    const { splitNames } = await import("../games/players");
    return runGameCommand({ game: "mafia", action: "start", names: splitNames(args.players ?? ""), nightSeconds: args.nightSeconds, daySeconds: args.daySeconds }, ctx);
  },
});
