import { NextRequest, NextResponse } from "next/server";
import { ensureSongsLoop, syncSongs } from "../../../../lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Checks Slack for new song requests, acts on them, and reports what happened.
// The first call after a server start also starts the background poll, so one request is enough
// to keep it running. `?force=1` skips the few-second throttle between runs.
export async function GET(request: NextRequest) {
  ensureSongsLoop();
  const status = await syncSongs({ force: request.nextUrl.searchParams.get("force") === "1" });
  return NextResponse.json(status, { headers: { "Cache-Control": "no-store" } });
}
