import { NextRequest, NextResponse } from "next/server";
import { agentRequestProblem } from "../../../../lib/agent-auth";
import { nudgeQuotes } from "../../../../lib/quotes";
import { isSlackFeed, markListenerAlive, markNudged, slackListenerLive } from "../../../../lib/slack-live";
import { ensureSongsLoop, nudgeSongs } from "../../../../lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 1024;
const SLACK_TS = /^\d{1,12}\.\d{1,8}$/;

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ ok: false, error }, status);

// From the Jarvis agent's Slack listener (lib/slack-live.ts): {"feed": "spots" | "chum" | "quotes" |
// "songs", "ts"?: "<message ts>"} when that channel changed, or {"feed": "listener"} once a minute.
// Only from this machine, with SCREEN_SECRET. The re-read happens here, in the Next process, which
// stays the only writer of .data/songs.json and .data/quotes.json; the answer does not wait for it.
export async function POST(request: NextRequest) {
  const problem = agentRequestProblem(request);
  if (problem) return refuse(problem.status, problem.error);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return refuse(400, "body too large");
  let body: { feed?: unknown; ts?: unknown };
  try {
    body = JSON.parse(raw) as { feed?: unknown; ts?: unknown };
  } catch {
    return refuse(400, "body must be JSON");
  }
  if (!body || typeof body !== "object") return refuse(400, "body must be a JSON object");
  const ts = typeof body.ts === "string" && SLACK_TS.test(body.ts) ? body.ts : null;

  if (body.feed === "listener") {
    markListenerAlive();
    // The fallback poll keeps running underneath (slower while the listener is up), as after a Next restart.
    ensureSongsLoop();
  } else if (isSlackFeed(body.feed)) {
    // spots and chum: the next GET re-reads Slack (lib/slack.ts, lib/chum.ts check nudgeCount).
    markNudged(body.feed);
    if (body.feed === "quotes") void nudgeQuotes();
    if (body.feed === "songs") void nudgeSongs(ts);
  } else {
    return refuse(400, "feed must be spots, chum, quotes, songs or listener");
  }
  return reply({ ok: true, feed: body.feed, listener: slackListenerLive() });
}
