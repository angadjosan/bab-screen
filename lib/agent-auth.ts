// The check for routes only the Jarvis agent may call (POST /api/screen, /api/slack/nudge, /api/spotify/agent):
// from this machine, with the header x-screen-secret equal to SCREEN_SECRET.

import { createHash, timingSafeEqual } from "node:crypto";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

// Next fills x-forwarded-for from the socket only when the request does not bring one, so this check alone
// is not proof of where a request came from. What keeps the endpoint local is the server listening on
// 127.0.0.1 only (package.json) plus the secret; this check and the Host check turn away anything that went
// through a proxy or a rebound DNS name on the way.
export function fromThisMachine(request: Request): boolean {
  const forwarded = (request.headers.get("x-forwarded-for") ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!forwarded.length || !forwarded.every((address) => LOOPBACK.has(address))) return false;
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK.has(host);
}

// Compared as hashes so the comparison takes the same time whatever the guess, and the lengths always match.
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

/** Null when the request is the agent's; otherwise the status and error to refuse it with. */
export function agentRequestProblem(request: Request): { status: number; error: string } | null {
  if (!fromThisMachine(request)) return { status: 403, error: "only accepted from 127.0.0.1" };
  const expected = process.env.SCREEN_SECRET?.trim();
  if (!expected) return { status: 403, error: "SCREEN_SECRET is not set on the server" };
  if (!secretMatches(request.headers.get("x-screen-secret"), expected)) return { status: 401, error: "wrong or missing x-screen-secret" };
  return null;
}
