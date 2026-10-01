"use client";

import { useEffect, useRef, useState } from "react";
import type { NowPlaying as NowPlayingData } from "../lib/now-playing";

const POLL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 8_000;
// How long the last known track stays up while /api/now-playing is failing.
const KEEP_LAST_MS = 20_000;
const BAR_TICK_MS = 500;

export function NowPlaying() {
  // null until the first reply; "idle" when there is nothing to show.
  const [data, setData] = useState<NowPlayingData | "idle" | null>(null);
  const [badArtwork, setBadArtwork] = useState<string | null>(null);
  // Position at the last poll and when (performance clock) it was received; the bar runs forward from here.
  const anchor = useRef({ positionMs: 0, at: 0 });
  const fill = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | null = null;
    let lastOk = performance.now();

    const poll = async () => {
      request = new AbortController();
      const giveUp = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      try {
        const response = await fetch("/api/now-playing", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Now playing request failed");
        const next = (await response.json()) as NowPlayingData;
        if (!alive) return;
        lastOk = performance.now();
        anchor.current = { positionMs: next.positionMs ?? 0, at: lastOk };
        setData(next);
      } catch {
        if (!alive) return;
        if (performance.now() - lastOk > KEEP_LAST_MS) setData("idle");
      } finally {
        window.clearTimeout(giveUp);
      }
      if (alive) timer = window.setTimeout(poll, POLL_MS);
    };
    poll();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, []);

  const track = data && data !== "idle" && (data.status === "playing" || data.status === "paused") && data.title ? data : null;
  const playing = track?.status === "playing";
  const durationMs = track?.durationMs ?? null;
  const trackId = track ? track.trackId ?? track.title : null;

  // Between polls the bar is moved straight on the element, so the tile re-renders only when a poll lands.
  useEffect(() => {
    const element = fill.current;
    if (!element || !durationMs) return;
    const paint = () => {
      const { positionMs, at } = anchor.current;
      const position = playing ? positionMs + (performance.now() - at) : positionMs;
      element.style.transform = `scaleX(${Math.min(1, Math.max(0, position / durationMs)).toFixed(5)})`;
    };
    paint();
    if (!playing) return;
    const ticker = window.setInterval(paint, BAR_TICK_MS);
    return () => window.clearInterval(ticker);
  }, [data, playing, durationMs, trackId]);

  if (!track) {
    const message =
      data === null ? "" :
      data !== "idle" && data.status === "unavailable"
        ? data.reason === "automation_permission"
          ? "To show the song, allow this app to control Spotify in System Settings > Privacy & Security > Automation"
          : "Spotify is not responding"
        : "Nothing playing";
    return (
      <section className="now-playing is-empty" aria-label="Now playing">
        <p className="now-playing-note">{message}</p>
      </section>
    );
  }

  const artwork = track.artworkUrl && track.artworkUrl !== badArtwork ? track.artworkUrl : null;
  return (
    <section className={`now-playing ${playing ? "" : "is-paused"} ${track.queuedBy ? "has-credit" : ""}`} aria-label="Now playing">
      <div className="now-playing-art">
        {artwork && <img key={artwork} src={artwork} alt={track.album ? `Cover of ${track.album}` : ""} onError={() => setBadArtwork(artwork)} />}
      </div>
      <div className="now-playing-body">
        <p className="now-playing-title">{track.title}</p>
        <div className="now-playing-meta">
          <span className="now-playing-artist">{track.artists ?? track.album ?? ""}</span>
          {!playing && <span className="now-playing-state">Paused</span>}
        </div>
        {/* Only for a track that came in through the Slack song-request channel. */}
        {track.queuedBy && (
          <p className="now-playing-credit">
            Queued by <span className="now-playing-credit-name">{track.queuedBy}</span>
          </p>
        )}
        {durationMs && (
          <div className="now-playing-bar" aria-hidden="true">
            <span key={trackId} ref={fill} className="now-playing-fill" />
          </div>
        )}
      </div>
    </section>
  );
}
