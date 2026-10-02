import { NextRequest, NextResponse } from "next/server";
import { CUES, coinFlipCue, type Cue } from "../../../../lib/coin-flip-sound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Only the dashboard itself may make noise, not another site open in the same browser.
  if (request.headers.get("sec-fetch-site") !== "same-origin") return new NextResponse(null, { status: 403 });
  const cue = request.nextUrl.searchParams.get("cue") as Cue;
  if (!CUES.includes(cue)) return new NextResponse(null, { status: 400 });
  await coinFlipCue(cue);
  return new NextResponse(null, { status: 204 });
}
