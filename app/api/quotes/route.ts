import { NextResponse } from "next/server";
import { DEFAULT_BATCH, getQuotes } from "../../../lib/quotes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Room for the refresh that a request starts in the background, after the reply.
export const maxDuration = 300;

// Answers from memory with a random sample of the pool (?count=, 40 by default, 100 at most).
// Reading Slack never happens inside a request: getQuotes starts it in the background when due.
export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("count");
  const count = raw === null ? DEFAULT_BATCH : Number(raw);
  return NextResponse.json(await getQuotes(count), { headers: { "Cache-Control": "no-store" } });
}
