import { NextRequest, NextResponse } from "next/server";
import { CUES, coinFlipCue, type Cue } from "../../../../lib/coin-flip-sound";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Spotify's volume is put back in the background, up to 30 s after a cue.
export const maxDuration = 60;

// The page plays the sounds; this only turns Spotify down and back up around the flip.
export async function POST(request: NextRequest) {
  // Only the dashboard itself may change the volume, not another site open in the same browser.
  if (request.headers.get("sec-fetch-site") !== "same-origin") return new NextResponse(null, { status: 403 });
  const cue = request.nextUrl.searchParams.get("cue") as Cue;
  if (!CUES.includes(cue)) return new NextResponse(null, { status: 400 });
  await coinFlipCue(cue);
  return new NextResponse(null, { status: 204 });
}
