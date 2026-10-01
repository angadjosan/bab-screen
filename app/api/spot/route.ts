import { NextResponse } from "next/server";
import { getLatestSpot } from "../../../lib/slack";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const spot = await getLatestSpot();
  return NextResponse.json(spot, {
    headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
  });
}
