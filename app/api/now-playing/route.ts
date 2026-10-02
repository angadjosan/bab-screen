import { NextResponse } from "next/server";
import { getJamView } from "../../../lib/jam";
import { getNowPlaying } from "../../../lib/now-playing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  // `jam` is set for the minute the tile shows the Jam QR instead of the song (lib/jam.ts).
  const [nowPlaying, jam] = await Promise.all([getNowPlaying(), getJamView()]);
  return NextResponse.json({ ...nowPlaying, jam }, {
    headers: { "Cache-Control": "no-store" },
  });
}
