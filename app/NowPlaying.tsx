"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { JamView } from "../lib/jam";
import type { NowPlaying as NowPlayingData } from "../lib/now-playing";

const POLL_MS = 4_000;
const REQUEST_TIMEOUT_MS = 8_000;
// How long the last known track stays up while /api/now-playing is failing.
const KEEP_LAST_MS = 20_000;
const BAR_TICK_MS = 500;
/** A cover that failed to load is tried again after this long; one failed request must not blank it for the whole song. */
const ARTWORK_RETRY_MS = 10_000;
// A showing with less than this left is not worth putting up (the last poll of a minute).
const JAM_MIN_LEFT_MS = 500;
// Side of the white square behind the Jam QR: the tile's height while the QR is up (.now-playing.is-jam in globals.css).
const JAM_QR_BOX_PX = 300;

type Reply = NowPlayingData & { jam?: JamView | null };
// endsAt is on this page's performance clock, so the tile goes back on time whatever the polls do.
type Jam = { view: JamView; endsAt: number };

/**
 * The Jam invite link as a QR code, shown in place of the song for a minute after someone asks for it in Slack.
 * A plain function, not a component: its <section> then takes the place of the song's in the same DOM element,
 * so the tile's height eases between 120px and 300px (and the column below follows) instead of snapping.
 */
function jamTile(jam: Jam) {
  const { view } = jam;
  if (!view.qr) {
    return (
      <section className="now-playing is-empty" aria-label="Spotify Jam">
        <p className="now-playing-note">No Jam link yet. Set one in Slack: @bot jam &lt;Jam invite link&gt;</p>
      </section>
    );
  }
  // A whole number of screen pixels per module, so every edge lands on a pixel boundary of the 1920x1080 stage.
  const side = Math.max(1, Math.floor(JAM_QR_BOX_PX / view.qr.modules)) * view.qr.modules;
  // Placed by whole pixels too: centring an odd leftover would put the code on half pixels.
  const inset = Math.max(0, Math.floor((JAM_QR_BOX_PX - side) / 2));
  // The bar empties over what is left of the minute. Fixed when this showing first arrived, so later polls do not restart it.
  const drain = { "--jam-from": (view.remainingMs / view.totalMs).toFixed(4), animationDuration: `${Math.round(view.remainingMs)}ms` } as CSSProperties;
  return (
    <section className="now-playing is-jam" aria-label="Spotify Jam">
      <div className="jam-qr">
        <svg viewBox={`0 0 ${view.qr.modules} ${view.qr.modules}`} width={side} height={side} style={{ margin: inset }} shapeRendering="crispEdges" role="img" aria-label="QR code of the Jam invite link">
          <path d={view.qr.path} />
        </svg>
      </div>
      <div className="jam-body">
        <p className="jam-eyebrow">Spotify Jam</p>
        <p className="jam-title">Scan to join the Jam</p>
        <p className="jam-hint">Add songs from your phone</p>
        <div className="now-playing-bar" aria-hidden="true">
          <span key={view.until} className="jam-drain" style={drain} />
        </div>
      </div>
    </section>
  );
}

/** The reply when it is a song to show: playing or paused, with a title. */
function playingTrack(data: NowPlayingData | "idle" | null): NowPlayingData | null {
  return data && data !== "idle" && (data.status === "playing" || data.status === "paused") && data.title ? data : null;
}

function emptyMessage(data: NowPlayingData | "idle" | null): string {
  if (data === null) return "";
  if (data !== "idle" && data.status === "unavailable") {
    return data.reason === "automation_permission"
      ? "To show the song, allow this app to control Spotify in System Settings > Privacy & Security > Automation"
      : "Spotify is not responding";
  }
  return "Nothing playing";
}

type TrackTile = {
  track: NowPlayingData;
  playing: boolean;
  durationMs: number | null;
  trackId: string | null;
  badArtwork: string | null;
  fill: RefObject<HTMLSpanElement | null>;
  onBadArtwork: (url: string) => void;
};

/** The song. A plain function like jamTile, so its <section> stays the same DOM element as the Jam's. */
function trackTile({ track, playing, durationMs, trackId, badArtwork, fill, onBadArtwork }: TrackTile) {
  const artwork = track.artworkUrl && track.artworkUrl !== badArtwork ? track.artworkUrl : null;
  return (
    <section className={`now-playing ${playing ? "" : "is-paused"} ${track.queuedBy ? "has-credit" : ""}`} aria-label="Now playing">
      <div className="now-playing-art">
        {artwork && <img key={artwork} src={artwork} alt={track.album ? `Cover of ${track.album}` : ""} onError={() => onBadArtwork(artwork)} />}
      </div>
      {trackBody(track, playing, durationMs, trackId, fill)}
    </section>
  );
}

function trackBody(track: NowPlayingData, playing: boolean, durationMs: number | null, trackId: string | null, fill: RefObject<HTMLSpanElement | null>) {
  return (
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
  );
}

export function NowPlaying() {
  // null until the first reply; "idle" when there is nothing to show.
  const [data, setData] = useState<NowPlayingData | "idle" | null>(null);
  const [badArtwork, setBadArtwork] = useState<string | null>(null);
  const [jam, setJam] = useState<Jam | null>(null);
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
        const next = (await response.json()) as Reply;
        if (!alive) return;
        lastOk = performance.now();
        anchor.current = { positionMs: next.positionMs ?? 0, at: lastOk };
        setData(next);
        const view = next.jam && next.jam.remainingMs > JAM_MIN_LEFT_MS ? next.jam : null;
        // Later polls of the same showing keep the first one's object and deadline.
        setJam((current) =>
          view
            ? current && current.view.until === view.until && current.view.url === view.url
              ? current
              : { view, endsAt: lastOk + view.remainingMs }
            : null,
        );
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

  // The QR comes down at its deadline even if no poll gets through to say so.
  const jamEndsAt = jam?.endsAt ?? null;
  useEffect(() => {
    if (jamEndsAt === null) return;
    const timer = window.setTimeout(
      () => setJam((current) => (current?.endsAt === jamEndsAt ? null : current)),
      Math.max(0, jamEndsAt - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [jamEndsAt]);

  // Forget a failed cover after a while, so the <img> is put back and asks for it again.
  useEffect(() => {
    if (!badArtwork) return;
    const timer = window.setTimeout(() => setBadArtwork(null), ARTWORK_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [badArtwork]);

  const track = playingTrack(data);
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
  }, [data, playing, durationMs, trackId, jam]);

  if (jam) return jamTile(jam);

  if (!track) {
    return (
      <section className="now-playing is-empty" aria-label="Now playing">
        <p className="now-playing-note">{emptyMessage(data)}</p>
      </section>
    );
  }

  return trackTile({ track, playing, durationMs, trackId, badArtwork, fill, onBadArtwork: setBadArtwork });
}
