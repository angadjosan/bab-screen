import { NextResponse } from "next/server";
import { getFeed } from "../../../lib/feed";
import { getNewsworthy } from "../../../lib/newsworthy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the refresh that a request starts in the background, after the reply.
export const maxDuration = 300;

// Answers from memory. The list is made inside the feed's background refresh (lib/feed.ts), so
// asking for it also counts as a screen watching the feed; no model is ever called in a request.
export async function GET() {
  try {
    await getFeed();
    return NextResponse.json(await getNewsworthy(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "error", tokens: [], updatedAt: null, agent: null, agentModel: null, message: "newsworthy tokens unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
