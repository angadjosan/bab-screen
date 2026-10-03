import { NextRequest, NextResponse } from "next/server";
import { agentRequestProblem } from "../../../../lib/agent-auth";
import { SpotifyError, addToQueue, expandShortLink, findTrackLinks, getTrack, searchTracks, type Track } from "../../../../lib/spotify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_BYTES = 1024;
const TRACK_ID = /^[A-Za-z0-9]{22}$/;

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });
const refuse = (status: number, error: string) => reply({ ok: false, error }, status);

// From the Jarvis agent's queue_track (agent/music.ts): {"op": "search", "query": "<artist and title, or a
// track link>"} answers {ok, track} (track null when nothing matches); {"op": "queue", "trackId": "<22 chars>"}
// adds it to the queue. Only from this machine, with SCREEN_SECRET. The Spotify calls happen here so the
// Next process stays the only one that refreshes and writes .data/spotify.json. A Spotify failure answers
// 200 with {ok: false, error: "<SpotifyError code>"}, for the agent to turn into words.
export async function POST(request: NextRequest) {
  const problem = agentRequestProblem(request);
  if (problem) return refuse(problem.status, problem.error);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return refuse(400, "body too large");
  let body: { op?: unknown; query?: unknown; trackId?: unknown };
  try {
    body = JSON.parse(raw) as { op?: unknown; query?: unknown; trackId?: unknown };
  } catch {
    return refuse(400, "body must be JSON");
  }
  if (!body || typeof body !== "object") return refuse(400, "body must be a JSON object");

  try {
    if (body.op === "search") {
      const query = typeof body.query === "string" ? body.query.trim().slice(0, 200) : "";
      if (!query) return refuse(400, "query is required");
      let track: Track | null;
      const link = findTrackLinks(query)[0];
      if (link) {
        const id = "trackId" in link ? link.trackId : await expandShortLink(link.shortLink);
        track = id ? await getTrack(id) : null;
      } else {
        track = (await searchTracks(query, 1))[0] ?? null;
      }
      return reply({ ok: true, link: Boolean(link), track });
    }
    if (body.op === "queue") {
      if (typeof body.trackId !== "string" || !TRACK_ID.test(body.trackId)) return refuse(400, "trackId must be a Spotify track ID");
      await addToQueue(body.trackId);
      return reply({ ok: true });
    }
  } catch (error) {
    return reply({ ok: false, error: error instanceof SpotifyError ? error.code : "spotify_error" });
  }
  return refuse(400, "op must be search or queue");
}
