import { NextResponse } from "next/server";
import { getClubNews } from "../../../lib/club-news";
import { ensureFeedLoop } from "../../../lib/feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stories about the club and its people for the feed column's spotlight (lib/club-news.ts). They are found by the
// feed's refresh, so asking for them keeps that loop running too.
export async function GET() {
  ensureFeedLoop();
  return NextResponse.json(await getClubNews(), { headers: { "Cache-Control": "no-store" } });
}
