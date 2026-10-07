import { queueTrack } from "../music";
import { defineTool, str } from "./types";

export default defineTool({
  name: "queue_track",
  description: "Find a song on Spotify and add it to the play queue. For a vibe (\"something chill\"), pick a specific real song yourself and queue it by artist and title.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "Artist and title, or a Spotify track link" } },
    required: ["query"],
    additionalProperties: false,
  },
  parse: (raw) => ({ query: str(raw, "query", 200) }),
  run: ({ query }, ctx) => queueTrack(query, { dryRun: ctx.dryRun }),
});
