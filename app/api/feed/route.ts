import { NextResponse } from "next/server";
import { getFeed } from "../../../lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the refresh that a request starts in the background, after the reply.
export const maxDuration = 300;

// Answers from memory. A request starts the background refresh when one is due (lib/feed.ts);
// fetching the sources and asking the model never happens inside a request.
export async function GET() {
  try {
    return NextResponse.json(await getFeed(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "error", items: [], updatedAt: null, sources: [], curation: "fallback", agent: null, agentModel: null, message: "feed unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
