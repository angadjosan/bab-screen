import { NextResponse } from "next/server";
import { getFeed } from "../../../lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Answers from memory. The first request starts the background refresh loop (lib/feed.ts);
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
