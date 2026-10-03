import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { runDueJobs } from "../../../../lib/tick";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The feed's refresh (fetching plus up to two model calls) is the longest job.
export const maxDuration = 300;

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  // Without a secret only a local server answers; a deployment must have one.
  if (!secret) return !process.env.VERCEL;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const wanted = Buffer.from(`Bearer ${secret}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

// Vercel Cron calls this (vercel.ts) with "Authorization: Bearer $CRON_SECRET". It runs every job
// that is due: song requests, coin flip, quotes and the feed. The screen's own requests start the
// same jobs, so this only matters while no screen is open, or as a backstop.
export async function GET(request: NextRequest) {
  if (!authorized(request)) return new NextResponse("Unauthorized", { status: 401 });
  return NextResponse.json({ ranAt: new Date().toISOString(), jobs: await runDueJobs() }, { headers: { "Cache-Control": "no-store" } });
}
