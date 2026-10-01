import { NextResponse } from "next/server";
import { getChumPhotos } from "../../../lib/chum";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The six newest photos of the chumming channel (lib/chum.ts), cached for a minute on the server.
export async function GET() {
  return NextResponse.json(await getChumPhotos(), {
    headers: { "Cache-Control": "private, max-age=0, must-revalidate" },
  });
}
