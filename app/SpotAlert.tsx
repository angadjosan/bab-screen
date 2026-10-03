"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./SpotAlert.module.css";

export type Spot = {
  id: string;
  imageUrl: string;
  text: string | null;
  spotter: string | null;
  spotted: string[];
  postedAt: string | null;
  permalink: string | null;
};
// /api/spot also mirrors spots[0] at the top level for older clients; only the list is used here.
type SpotResponse = { status: "ok" | "empty" | "unconfigured" | "error"; spots: Spot[] };

const POLL_MS = 30_000;
/** How long a new spot holds the whole screen. */
export const TAKEOVER_MS = 12_000;
/** How long a photo may take to load before the takeover goes up without waiting for it. */
const PHOTO_WAIT_MS = 6_000;
/** A spot stays in the list under the feed for this long after it was posted. */
export const RECENT_SPOT_MS = 60 * 60_000;
const RECENT_LIMIT = 3;
/** A spot this new has a lit marker in the list. */
const FRESH_MS = 10 * 60_000;
const CLOCK_MS = 30_000;
/** A headline longer than this is set a size down in the takeover. */
const LONG_HEADLINE_CHARS = 26;

const nameList = new Intl.ListFormat("en-US", { style: "long", type: "conjunction" });
const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

// The message text is only worth showing when it says more than "spot" plus the mentions already in the headline.
function spotNote(spot: Spot) {
  if (!spot.text) return null;
  let rest = spot.text;
  for (const name of [...spot.spotted].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join(" ");
  rest = rest.replace(/\bspot(s|ted|ting)?\b/gi, " ");
  return /[^\s.,!?:;'"()@#*_~-]/.test(rest) ? spot.text : null;
}

/** The message with the spotted people's @mentions taken out, since their names are the headline. */
function noteWithoutNames(spot: Spot, note: string) {
  let rest = note;
  for (const name of [...spot.spotted].sort((a, b) => b.length - a.length)) rest = rest.split(`@${name}`).join("");
  return rest.replace(/\s+/g, " ").trim();
}

function spotHeadline(spot: Spot) {
  return spot.spotted.length ? nameList.format(spot.spotted) : spotNote(spot) ?? "Spotted";
}

function spotCredit(spot: Spot) {
  return spot.spotter ? `Spot by ${spot.spotter}` : "Spotted";
}

function spotAge(postedAt: string | null, now: number) {
  const posted = postedAt ? Date.parse(postedAt) : NaN;
  if (!Number.isFinite(posted)) return null;
  const minutes = Math.floor((now - posted) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function postedWithin(spot: Spot, now: number, ms: number) {
  const posted = spot.postedAt ? Date.parse(spot.postedAt) : NaN;
  return Number.isFinite(posted) && now - posted < ms;
}

async function fetchSpots(): Promise<Spot[] | null> {
  try {
    const response = await fetch("/api/spot", { cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as SpotResponse;
    return Array.isArray(body.spots) ? body.spots : [];
  } catch {
    return null;
  }
}

/** Resolves once the photo has loaded or failed, or after PHOTO_WAIT_MS, whichever comes first. */
function preload(url: string) {
  return new Promise<void>((resolve) => {
    const image = new Image();
    image.onload = () => resolve();
    image.onerror = () => resolve();
    window.setTimeout(resolve, PHOTO_WAIT_MS);
    image.src = url;
  });
}

/**
 * Spotbot's posts, read every 30 seconds. A spot that was not in the previous answer takes over the screen for
 * TAKEOVER_MS once its photo has loaded; spots that were already there when the page loaded never do. `recent`
 * is the spots of the last hour, newest first, for the list under the feed.
 */
export function useSpotAlerts() {
  const [spots, setSpots] = useState<Spot[]>([]);
  const [takeover, setTakeover] = useState<Spot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const list = await fetchSpots();
      // Keep showing the last good list; the next poll tries again.
      if (!alive || !list) return;
      const previous = known.current;
      known.current = new Set(list.map((spot) => spot.id));
      setSpots(list);
      setNow(Date.now());
      const arrival = previous ? list.find((spot) => !previous.has(spot.id)) : undefined;
      if (!arrival) return;
      await preload(arrival.imageUrl);
      if (alive) setTakeover(arrival);
    };
    void poll();
    const pollTimer = window.setInterval(poll, POLL_MS);
    const clockTimer = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      alive = false;
      window.clearInterval(pollTimer);
      window.clearInterval(clockTimer);
    };
  }, []);

  const takeoverId = takeover?.id ?? null;
  useEffect(() => {
    if (!takeoverId) return;
    const timer = window.setTimeout(() => setTakeover(null), TAKEOVER_MS);
    return () => window.clearTimeout(timer);
  }, [takeoverId]);

  const recent = spots.filter((spot) => spot.id !== takeoverId && postedWithin(spot, now, RECENT_SPOT_MS)).slice(0, RECENT_LIMIT);
  return { takeover, recent, now };
}

/** The spots of the last hour as a short list under the feed, text only. Takes no space when there are none. */
export function RecentSpots({ spots, now }: { spots: readonly Spot[]; now: number }) {
  if (!spots.length) return null;
  return (
    <section className={styles.recent} aria-label="Recent spots">
      <ol className={styles.list}>
        {spots.map((spot) => (
          <li key={spot.id} className={styles.row}>
            <span className={cx(styles.marker, postedWithin(spot, now, FRESH_MS) && styles.fresh)} aria-hidden="true" />
            <div className={styles.rowBody}>
              <p className={styles.rowNames}>{spotHeadline(spot)}</p>
              <p className={styles.rowMeta}>
                <span className={styles.rowBy}>{spotCredit(spot)}</span>
                <span className={styles.rowTime}>{spotAge(spot.postedAt, now)}</span>
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** A new spot, across the whole screen: the photo, who was spotted, what was said and who spotted them. */
export function SpotTakeover({ spot, now }: { spot: Spot | null; now: number }) {
  if (!spot) return null;
  const fullNote = spot.spotted.length ? spotNote(spot) : null;
  const note = fullNote ? noteWithoutNames(spot, fullNote) : null;
  const headline = spotHeadline(spot);
  const age = spotAge(spot.postedAt, now);
  return (
    <div key={spot.id} className={styles.takeover} role="status">
      <div className={styles.photo}>
        <img src={spot.imageUrl} alt={headline} />
      </div>
      <div className={styles.words}>
        <p className={cx(styles.headline, headline.length > LONG_HEADLINE_CHARS && styles.long)}>{headline}</p>
        {note && <p className={styles.note}>{note}</p>}
        <p className={styles.credit}>
          <span>{spotCredit(spot)}</span>
          {age && <span className={styles.age}>{age}</span>}
        </p>
      </div>
      <span className={styles.countdown} style={{ animationDuration: `${TAKEOVER_MS}ms` }} aria-hidden="true" />
    </div>
  );
}
