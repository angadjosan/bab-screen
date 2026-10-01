"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FeaturedMarket, MarketsProvider, TickerTape } from "./Markets";
import { NowPlaying } from "./NowPlaying";

type Spot = {
  id: string;
  imageUrl: string;
  text: string | null;
  spotter: string | null;
  spotted: string[];
  postedAt: string | null;
  permalink: string | null;
};
// /api/spot also mirrors spots[0] at the top level for older clients; only the list is used here.
type SpotResponse = {
  status: "ok" | "empty" | "unconfigured" | "error";
  spots: Spot[];
  message?: string;
};

const SPOT_SLIDE_MS = 8_000;
const SPOT_RETRY_MS = 5 * 60_000;
const nameList = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });

// The message text is only worth showing when it says more than "spot" plus the mentions already in the headline.
function spotNote(spot: Spot) {
  if (!spot.text) return null;
  let rest = spot.text;
  for (const name of [...spot.spotted].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join(" ");
  rest = rest.replace(/\bspot(s|ted|ting)?\b/gi, " ");
  return /[^\s.,!?:;'"()@#*_~-]/.test(rest) ? spot.text : null;
}

function spotAge(postedAt: string | null, now: number) {
  const posted = postedAt ? Date.parse(postedAt) : NaN;
  if (!Number.isFinite(posted)) return null;
  const minutes = Math.floor((now - posted) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d ago`;
  return new Date(posted).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function SpotCard({ spot, loading }: { spot: SpotResponse | null; loading: boolean }) {
  const spots = spot?.spots ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const knownIds = useRef<Set<string> | null>(null);

  // Photos that failed to load stay mounted (hidden) so they can be retried, but drop out of the rotation.
  const slides = spots.filter((s) => !failed.has(s.id));
  const index = Math.max(0, slides.findIndex((s) => s.id === activeId));
  const currentId = slides[index]?.id ?? null;
  const nextId = slides.length > 1 ? slides[(index + 1) % slides.length].id : null;
  const newestId = spots[0]?.id ?? null;
  const idsKey = spots.map((s) => s.id).join(",");
  const anyFailed = failed.size > 0;

  const markFailed = (id: string, bad: boolean) => setFailed((prev) => {
    if (prev.has(id) === bad) return prev;
    const next = new Set(prev);
    if (bad) next.add(id); else next.delete(id);
    return next;
  });

  // When a poll brings a spot that was not in the previous list, show it straight away.
  useEffect(() => {
    const previous = knownIds.current;
    knownIds.current = new Set(idsKey ? idsKey.split(",") : []);
    if (previous && newestId && !previous.has(newestId)) setActiveId(newestId);
  }, [idsKey, newestId]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!anyFailed) return;
    const timer = window.setInterval(() => setRetry((n) => n + 1), SPOT_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [anyFailed]);

  if (!spots.length) {
    return (
      <section className="spot-card">
        <div className="spot-empty">{spot?.status === "unconfigured" ? "Slack is not connected" : loading ? "Checking Slack…" : "No sighting yet"}</div>
      </section>
    );
  }
  return (
    <section className="spot-card">
      <div className="spot-image-frame">
        {spots.map((s) => {
          const who = s.spotted.length ? nameList.format(s.spotted) : null;
          const alt = [who ? `Photo of ${who}` : s.text?.trim() || "Spotted photo", s.spotter && `spotted by ${s.spotter}`].filter(Boolean).join(", ");
          return (
            <img
              key={failed.has(s.id) ? `${s.id}:${retry}` : s.id}
              src={s.imageUrl}
              alt={alt}
              aria-hidden={s.id !== currentId}
              className={`spot-image ${s.id === currentId ? "is-active" : ""}`}
              onLoad={() => markFailed(s.id, false)}
              onError={() => markFailed(s.id, true)}
            />
          );
        })}
        {!slides.length && <div className="spot-empty">Photo unavailable</div>}
      </div>
      {/* The fill is the carousel's only clock: it is mounted afresh for each photo and the photo advances when it finishes. */}
      {slides.length > 1 && (
        <div className="spot-steps" aria-hidden="true">
          {slides.map((s, i) => (
            <span key={s.id} className={`spot-step ${i < index ? "is-done" : ""}`}>
              {i === index && <span className="spot-step-fill" style={{ animationDuration: `${SPOT_SLIDE_MS}ms` }} onAnimationEnd={() => setActiveId(nextId)} />}
            </span>
          ))}
        </div>
      )}
      <div className="spot-caption">
        {slides.map((s) => {
          const note = spotNote(s);
          const age = spotAge(s.postedAt, now);
          return (
            <div key={s.id} className={`spot-caption-item ${s.id === currentId ? "is-active" : ""}`} aria-hidden={s.id !== currentId}>
              <p className="spot-names">{s.spotted.length ? nameList.format(s.spotted) : note ?? "Spotted"}</p>
              {note && s.spotted.length > 0 && <p className="spot-text">{note}</p>}
              {(s.spotter || age) && (
                <div className="spot-meta">
                  {s.spotter && <span className="spot-by">Spot by {s.spotter}</span>}
                  {age && <span className="spot-time">{age}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const [spot, setSpot] = useState<SpotResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/spot", { cache: "no-store" });
      if (!response.ok) throw new Error("Spot request failed");
      setSpot((await response.json()) as SpotResponse);
    } catch {
      // Keep showing the last good list; the next poll tries again.
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const dataTimer = window.setInterval(() => refresh(), 30_000);
    return () => window.clearInterval(dataTimer);
  }, [refresh]);

  useEffect(() => {
    const fit = () => document.documentElement.style.setProperty("--fit", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <MarketsProvider>
      <main className="dashboard">
        <div className="top-row">
          <img className="brand-logo" src="/bab-logo.svg" alt="Blockchain at Berkeley" width={344} height={311} />
          <div className="tape-slot"><TickerTape /></div>
        </div>
        <div className="featured-slot"><FeaturedMarket /></div>
        <div className="side-slot">
          <NowPlaying />
          <SpotCard spot={spot} loading={loading} />
        </div>
      </main>
    </MarketsProvider>
  );
}
