import { NextResponse } from "next/server";
import { getFeed } from "../../../lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Answers from memory. The first request starts the background refresh loop (lib/feed.ts);
// fetching the sources and asking Claude never happens inside a request.
export async function GET() {
  try {
    return NextResponse.json(await getFeed(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "error", items: [], updatedAt: null, sources: [], curation: "fallback", message: "feed unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
