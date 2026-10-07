import { runGameCommand } from "../games";
import { ArgError, defineTool, oneOf, str } from "./types";

const ACTIONS = ["start", "buy_in", "stack", "cash_out", "settle", "status", "end"] as const;

export default defineTool({
  name: "poker",
  description:
    "Poker tracker, play money only (records numbers, never moves money). start a game (optional title, players, amount each); buy_in for a buy-in or rebuy; stack for a chip count; cash_out when someone leaves with their chips; settle at the end for who pays whom; status for the table; end to close it. Shown on the TV.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      player: { type: "string", description: "Player name, or 'me'" },
      amount: { type: "number", description: "Buy-in, stack or cash-out amount" },
      title: { type: "string", description: "start only" },
      players: { type: "string", description: "start only: comma-separated names" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const action = oneOf(raw, "action", ACTIONS);
    if (action === "buy_in" || action === "stack" || action === "cash_out") {
      const amount = Number(raw.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new ArgError("amount must be a non-negative number");
      return { action, player: str(raw, "player", 40), amount };
    }
    if (action === "start") {
      const amount = raw.amount === undefined || raw.amount === null || raw.amount === "" ? undefined : Number(raw.amount);
      if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) throw new ArgError("amount must be a positive number");
      const players = str(raw, "players", 600, { optional: true }).split(/\s*,\s*/).map((name) => name.replace(/^@/, "").trim()).filter(Boolean).slice(0, 20);
      return { action, title: str(raw, "title", 60, { optional: true }), players, amount };
    }
    return { action };
  },
  run: async (args, ctx) => {
    const result = await runGameCommand({ game: "poker", ...args } as Parameters<typeof runGameCommand>[0], ctx);
    return { ok: result.ok, result: result.reply };
  },
});
