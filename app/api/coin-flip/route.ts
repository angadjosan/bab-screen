import { NextResponse } from "next/server";
import { getCoinFlipView } from "../../../lib/coin-flip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the round a request starts in the background, after the reply (lib/coin-flip.ts).
export const maxDuration = 300;

export async function GET() {
  return NextResponse.json(await getCoinFlipView(), { headers: { "Cache-Control": "no-store" } });
}
