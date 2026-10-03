import { NextRequest, NextResponse } from "next/server";
import { ensureSongsLoop, syncSongs } from "../../../../lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Checks Slack for new song requests, acts on them, and reports what happened.
// On a long-running server the first call also starts the background poll (the screen's
// /api/now-playing requests start it too). `?force=1` runs a round even if one is not due yet.
export async function GET(request: NextRequest) {
  ensureSongsLoop();
  const status = await syncSongs({ force: request.nextUrl.searchParams.get("force") === "1" });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
