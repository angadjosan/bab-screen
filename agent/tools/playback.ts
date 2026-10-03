import { playback, type PlaybackAction } from "../music";
import { defineTool, int, oneOf } from "./types";

const ACTIONS = ["play", "pause", "next", "previous", "volume_up", "volume_down", "volume_set", "status"] as const satisfies readonly PlaybackAction[];

export default defineTool({
  name: "playback",
  description: "Control the Spotify app on the clubroom Mac: play, pause, next, previous, volume, or read what is playing (status).",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...ACTIONS] },
      volume: { type: "integer", description: "0-100, only for volume_set" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  parse: (raw) => {
    const action = oneOf(raw, "action", ACTIONS);
    return { action, volume: action === "volume_set" ? int(raw, "volume", 0, 100) : undefined };
  },
  run: ({ action, volume }, ctx) => playback(action, { volume, dryRun: ctx.dryRun }),
});
