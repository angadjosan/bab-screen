import { NextRequest, NextResponse } from "next/server";
import { agentRequestProblem } from "../../../lib/agent-auth";
import { applyScreenOp, getScreenState } from "../../../lib/screen-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
/** Request bodies are a few small fields; anything bigger is not one of ours. */
const MAX_BODY_BYTES = 32 * 1024;

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ ok: false, error }, status);

// What the screen shows now. The page itself listens on /api/screen/stream instead.
export async function GET() {
  return reply(await getScreenState());
}

// One op from the agent (lib/screen-state.ts lists them). Only from this machine, with SCREEN_SECRET.
export async function POST(request: NextRequest) {
  const problem = agentRequestProblem(request);
  if (problem) return refuse(problem.status, problem.error);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return refuse(400, "body too large");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, "body must be JSON");
  }
  const result = await applyScreenOp(body);
  return result.ok ? reply(result) : refuse(400, result.error);
}
