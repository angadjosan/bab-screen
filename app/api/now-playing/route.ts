import { NextResponse } from "next/server";
import { getJamView } from "../../../lib/jam";
import { inBackground, runJob } from "../../../lib/jobs";
import { getNowPlaying } from "../../../lib/now-playing";
import { ensureSongsLoop, songsJob, songsPolling } from "../../../lib/songs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for a round of song requests started below, after the reply.
export const maxDuration = 300;

export async function GET() {
  // The screen asks for this every few seconds, so it also keeps the song requests going: a round
  // runs in the background when one is due (and on a long-running server the poll timer starts).
  if (songsPolling()) {
    ensureSongsLoop();
    inBackground(runJob(songsJob));
  }
  // `jam` is set for the minute the tile shows the Jam QR instead of the song (lib/jam.ts).
  const [nowPlaying, jam] = await Promise.all([getNowPlaying(), getJamView()]);
  return NextResponse.json({ ...nowPlaying, jam }, {
    headers: { "Cache-Control": "no-store" },
  });
}
