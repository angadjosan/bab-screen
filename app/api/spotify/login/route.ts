import { NextRequest, NextResponse } from "next/server";
import { authorizeUrl, newOAuthState, redirectUri, spotifyConfig } from "../../../../lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "spotify_oauth_state";

/** The address this page was opened at, as the browser sees it (Vercel and other proxies set the forwarded headers). */
function requestOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || request.nextUrl.protocol.replace(/:$/, "");
  return `${proto}://${host}`;
}

// Starts Spotify's Authorization Code flow. Open this once in a browser, signed in to Spotify as
// the account that plays on the screen.
export async function GET(request: NextRequest) {
  const origin = requestOrigin(request);
  const redirect = redirectUri(origin);
  if (!spotifyConfig()) {
    return new NextResponse(
      "Spotify is not configured. Create an app at https://developer.spotify.com/dashboard, add the redirect URI " +
        `${redirect} to it, and set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (.env.local, or the Vercel project's environment variables).`,
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  // The state cookie must be set on the same host Spotify redirects back to (127.0.0.1 rather than
  // localhost on the Mac, since Spotify does not accept "localhost"; the production domain on a
  // Vercel preview), so bounce there first if the page was opened elsewhere.
  const callback = new URL(redirect);
  if (new URL(origin).host !== callback.host) {
    return NextResponse.redirect(new URL("/api/spotify/login", callback.origin));
  }

  const state = newOAuthState();
  const response = NextResponse.redirect(authorizeUrl(state, redirect));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: callback.protocol === "https:",
    path: "/api/spotify",
    maxAge: 600,
  });
  return response;
}
