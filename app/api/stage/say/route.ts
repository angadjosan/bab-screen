import { NextRequest, NextResponse } from "next/server";
import { agentRequestProblem } from "../../../../lib/agent-auth";
import { releaseMusic, speak } from "../../../../lib/stage/voice";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_CHARS = 600;

// The Slack agent saying something in the room (agent/speech.ts): {"text": "..."} is said in Worm's voice, with the
// music dimmed while it is said, and the answer comes once it has been said. Only from this machine, with SCREEN_SECRET.
export async function POST(request: NextRequest) {
  const problem = agentRequestProblem(request);
  if (problem) return NextResponse.json({ ok: false, error: problem.error }, { status: problem.status });
  const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_CHARS) : "";
  if (!text) return NextResponse.json({ ok: false, error: "text is required" }, { status: 400 });
  await speak(text);
  releaseMusic();
  return NextResponse.json({ ok: true });
}
