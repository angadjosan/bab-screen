import { NextRequest, NextResponse } from "next/server";
import { authorizeUrl, newOAuthState, redirectUri, spotifyConfig } from "../../../../lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "spotify_oauth_state";

// Starts Spotify's Authorization Code flow. Open this once, on this computer, in a browser.
export async function GET(request: NextRequest) {
  if (!spotifyConfig()) {
    return new NextResponse(
      "Spotify is not configured. Create an app at https://developer.spotify.com/dashboard, add the redirect URI " +
        `${redirectUri()} to it, and set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env.local.`,
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // The state cookie must be set on the same host Spotify redirects back to (127.0.0.1, since
  // Spotify does not accept "localhost"), so bounce there first if the page was opened elsewhere.
  const callback = new URL(redirectUri());
  const requestHost = request.headers.get("host") ?? request.nextUrl.host;
  if (requestHost !== callback.host) {
    return NextResponse.redirect(new URL("/api/spotify/login", callback.origin));
  }

  const state = newOAuthState();
  const response = NextResponse.redirect(authorizeUrl(state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: callback.protocol === "https:",
    path: "/api/spotify",
    maxAge: 600,
  });
  return response;
}
