import { NextResponse } from "next/server";
import { getCoinFlipView } from "../../../lib/coin-flip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getCoinFlipView(), { headers: { "Cache-Control": "no-store" } });
}
