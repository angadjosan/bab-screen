import { NextRequest, NextResponse } from "next/server";
import { closeStage } from "../../../lib/stage/state";
import { askWorm, cancelTurn } from "../../../lib/stage/turn";
import { releaseMusic } from "../../../lib/stage/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const QUESTION_MAX = 500;

/** Only this Mac may ask: a page elsewhere on the network, or another site in the same browser, may not. */
function fromThisMac(request: NextRequest): boolean {
  const host = request.headers.get("host") ?? "";
  const site = request.headers.get("sec-fetch-site");
  return /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host) && (site === null || site === "same-origin" || site === "none");
}

// Ask Worm something without saying it: {"text": "..."} answers on the stage as if it had been said, and
// {"close": true} hands the screen back; {"demo": true} streams a canned answer without asking a model (lib/stage/demo.ts).
// For testing, and for anything on this Mac that wants the stage.
export async function POST(request: NextRequest) {
  if (!fromThisMac(request)) return new NextResponse(null, { status: 403 });
  const body = (await request.json().catch(() => null)) as { text?: unknown; close?: unknown; demo?: unknown } | null;
  if (body?.close === true) {
    cancelTurn();
    closeStage();
    releaseMusic(0);
    return new NextResponse(null, { status: 204 });
  }
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, QUESTION_MAX) : "";
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });
  void askWorm(text, undefined, { demo: body?.demo === true });
  return NextResponse.json({ asked: text }, { status: 202 });
}
