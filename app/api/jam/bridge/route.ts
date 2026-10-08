import { NextRequest, NextResponse } from "next/server";
import { bridgeAuthorized, bridgeStatus, finishJamRequest, nextJamRequest, requestFreshJam } from "../../../../lib/jam-bridge";
import { jamLink, recordJamTrigger, getJamStatus } from "../../../../lib/jam";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function response(request: NextRequest, value: unknown, status = 200) {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (origin === "https://xpui.app.spotify.com" || origin === "null") {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Vary"] = "Origin";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type";
    headers["Access-Control-Allow-Private-Network"] = "true";
  }
  return NextResponse.json(value, { status, headers });
}

export async function OPTIONS(request: NextRequest) { return response(request, {}); }

export async function GET(request: NextRequest) {
  if (!await bridgeAuthorized(request.headers.get("authorization"))) return response(request, { error: "Unauthorized" }, 401);
  return response(request, request.nextUrl.searchParams.get("status") === "1" ? bridgeStatus() : nextJamRequest());
}

type BridgeBody = { action?: string; id?: string; url?: string; error?: string; show?: boolean };

async function parseBody(request: NextRequest): Promise<{ body?: BridgeBody; error?: string; status?: number }> {
  const raw = await request.text();
  if (raw.length > 4096) return { error: "Too large", status: 413 };
  try {
    return { body: JSON.parse(raw) as BridgeBody };
  } catch {
    return { error: "Invalid JSON", status: 400 };
  }
}

async function handleRequestAction(request: NextRequest, show: boolean | undefined) {
  try {
    if (show === true) {
      const result = await recordJamTrigger({ link: null, postedAtMs: Date.now(), user: null });
      if (result.error) throw new Error(result.error);
      return response(request, { ...result, jam: await getJamStatus() });
    }
    const url = jamLink(await requestFreshJam());
    if (!url) throw new Error("Spotify returned an invalid invite URL.");
    return response(request, { url });
  } catch (error) {
    return response(request, { error: error instanceof Error ? error.message : "Jam failed" }, 502);
  }
}

export async function POST(request: NextRequest) {
  if (!await bridgeAuthorized(request.headers.get("authorization"))) return response(request, { error: "Unauthorized" }, 401);
  const parsed = await parseBody(request);
  if (parsed.error) return response(request, { error: parsed.error }, parsed.status);
  const body = parsed.body;
  if (body?.action === "request") return handleRequestAction(request, body.show);
  if (!body || typeof body.id !== "string") return response(request, { error: "Missing request ID" }, 400);
  const url = jamLink(body.url);
  const error = typeof body.error === "string" ? body.error.slice(0, 500) : undefined;
  if (!url && !error) return response(request, { error: "Invalid invite" }, 400);
  return response(request, { accepted: finishJamRequest(body.id, { url: url ?? undefined, error }) });
}
