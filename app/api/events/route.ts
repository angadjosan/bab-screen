import { NextResponse } from "next/server";
import { EVENTS_TIME_ZONE, getEvents } from "../../../lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Answers from memory. A request starts the calendar download in the background when the list is
// due for a refresh (lib/events.ts); it never waits for Google.
export async function GET() {
  try {
    return NextResponse.json(getEvents(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { status: "error", events: [], updatedAt: null, now: new Date().toISOString(), timeZone: EVENTS_TIME_ZONE, stale: false, message: "events unavailable" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
