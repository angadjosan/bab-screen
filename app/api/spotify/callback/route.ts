import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { SpotifyError, exchangeCode } from "../../../../lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "spotify_oauth_state";

function page(title: string, body: string, status: number): NextResponse {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const response = new NextResponse(
    `<!doctype html><meta charset="utf-8"><title>${escape(title)}</title>` +
      `<body style="font-family:system-ui;margin:3rem;max-width:40rem"><h1>${escape(title)}</h1><p>${escape(body)}</p></body>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
  response.cookies.set(STATE_COOKIE, "", { path: "/api/spotify", maxAge: 0 });
  return response;
}

function sameState(expected: string | undefined, actual: string | null): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Spotify redirects here after the user approves (or denies) access.
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  if (!sameState(request.cookies.get(STATE_COOKIE)?.value, params.get("state"))) {
    return page("Spotify login failed", "The login could not be verified (state mismatch). Start again at /api/spotify/login.", 400);
  }
  const denied = params.get("error");
  if (denied) {
    return page("Spotify login cancelled", `Spotify reported: ${denied}. Start again at /api/spotify/login.`, 400);
  }
  const code = params.get("code");
  if (!code) return page("Spotify login failed", "Spotify did not send an authorization code.", 400);

  try {
    await exchangeCode(code);
  } catch (error) {
    const reason = error instanceof SpotifyError ? error.code : "unexpected_error";
    console.error("Spotify code exchange failed:", reason);
    return page("Spotify login failed", `Could not finish connecting (${reason}). Check the client ID, secret and redirect URI, then try again.`, 502);
  }
  return page("Spotify connected", "Song requests from Slack will now be added. You can close this tab.", 200);
}
