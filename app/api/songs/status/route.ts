import { NextResponse } from "next/server";
import { getSongsStatus } from "../../../../lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: reports the stored state without contacting Slack or Spotify.
export async function GET() {
  return NextResponse.json(await getSongsStatus(), { headers: { "Cache-Control": "no-store" } });
}
