import { NextResponse } from "next/server";
import { getNowPlaying } from "../../../lib/now-playing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getNowPlaying(), {
    headers: { "Cache-Control": "no-store" },
  });
}
