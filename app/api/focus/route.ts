import { NextResponse } from "next/server";
import { getFocusView } from "../../../lib/commands";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Whether the screen is in focus mode (lib/commands.ts). Switched from Slack with "@bot focus" and "@bot focus off".
export async function GET() {
  return NextResponse.json(await getFocusView(), { headers: { "Cache-Control": "no-store" } });
}
