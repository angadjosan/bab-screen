"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChumCaption, chumAlt, createChumDeck, useChumPhotos, type ChumDeck } from "./Chum";
import { CoinFlip } from "./CoinFlip";
import { Events } from "./Events";
import { Feed } from "./Feed";
import { FeaturedMarket, MarketsProvider, TickerTape } from "./Markets";
import { NowPlaying } from "./NowPlaying";
import { QuoteCaption, QuoteFrame, useQuoteDeck, type Quote } from "./Quotes";
import { RecentSpots, SpotTakeover, useSpotAlerts } from "./SpotAlert";

/** How often the page asks whether focus mode is on (switched from Slack, lib/commands.ts). */
const FOCUS_POLL_MS = 4_000;
/** How long each slide of the carousel stays up. */
const SLIDE_MS = 8_000;
/** A slide whose picture is still loading when its turn comes is waited for this long, then passed over. */
const SLIDE_LOAD_GRACE_MS = 6_000;
const SLIDE_READY_POLL_MS = 250;
const PHOTO_RETRY_MS = 5 * 60_000;
/** Quotes drawn in a row while looking for one that has something to show. */
const QUOTE_DRAWS = 6;
/** A chumming photo follows this many quotes: two or three, at random. */
const chumGap = () => 2 + Math.floor(Math.random() * 2);

// One turn of the carousel: a chumming photo (by id, so it follows the list as polls replace it), or a quote.
type Slide =
  | { kind: "chum"; key: string; id: string }
  | { kind: "quote"; key: string; quote: Quote };
// `upcoming` is chosen a whole turn ahead and mounted hidden, so its picture has loaded before the crossfade;
// `previous` stays mounted so it can fade out.
type Show = { previous: Slide | null; current: Slide | null; upcoming: Slide | null };

const chumKey = (id: string) => `chum:${id}`;
const chumSlide = (id: string): Slide => ({ kind: "chum", key: chumKey(id), id });
const quoteSlide = (quote: Quote): Slide => ({ kind: "quote", key: `quote:${quote.id}`, quote });

function slideReady(frame: HTMLElement | null, slide: Slide) {
  const layer = frame?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(slide.key)}"]`);
  if (!layer) return false;
  const image = layer instanceof HTMLImageElement ? layer : layer.querySelector("img");
  return !image || (image.complete && image.naturalWidth > 0);
}

function quotesOnShow(show: Show) {
  const quotes: Array<Extract<Slide, { kind: "quote" }>> = [];
  for (const slide of [show.previous, show.current, show.upcoming]) {
    if (slide?.kind === "quote" && !quotes.some((q) => q.key === slide.key)) quotes.push(slide);
  }
  return quotes;
}

/** Chumming photos that failed to load drop out of the rotation and are retried every 5 minutes. */
function useFailedPhotos() {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  const anyFailed = failed.size > 0;
  useEffect(() => {
    if (!anyFailed) return;
    const timer = window.setInterval(() => setRetry((n) => n + 1), PHOTO_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [anyFailed]);
  const markFailed = useCallback((key: string, bad: boolean) => setFailed((prev) => {
    if (prev.has(key) === bad) return prev;
    const next = new Set(prev);
    if (bad) next.add(key); else next.delete(key);
    return next;
  }), []);
  return { failed, retry, markFailed };
}

/**
 * What follows a slide. Quotes are the backbone, at random from the deck; a chumming photo is slipped in after
 * every two or three of them, in shuffled order through all six before any comes back, and never two in a row
 * unless chumming photos are all there is. Takes a quote from the deck, so only call it from an effect or a timer.
 */
function usePicker(nextQuote: () => Quote | null, failed: ReadonlySet<string>, hasQuotes: boolean) {
  const chumDeck = useRef<ChumDeck | null>(null);
  if (chumDeck.current === null) chumDeck.current = createChumDeck();
  /** Quotes still to pick before the next chumming photo. */
  const untilChum = useRef(-1);
  if (untilChum.current < 0) untilChum.current = chumGap();
  const pool = useRef({ failed, hasQuotes });
  pool.current = { failed, hasQuotes };

  const pick = useCallback((after: Slide | null): Slide | null => {
    const { failed: bad, hasQuotes: quotes } = pool.current;
    const quoteAfter = (): Slide | null => {
      for (let draw = 0; quotes && draw < QUOTE_DRAWS; draw += 1) {
        const quote = nextQuote();
        if (!quote || (after?.kind === "quote" && after.quote.id === quote.id)) return null;
        if (quote.imageUrl || quote.text) return quoteSlide(quote);
      }
      return null;
    };
    const chumAfter = (): Slide | null => {
      const id = chumDeck.current?.next((photo) => !bad.has(chumKey(photo)), after?.kind === "chum" ? after.id : null);
      if (!id) return null;
      untilChum.current = chumGap();
      return chumSlide(id);
    };
    if (after?.kind !== "chum" && untilChum.current <= 0) {
      const due = chumAfter();
      if (due) return due;
    }
    const quote = quoteAfter();
    if (!quote) return chumAfter();
    untilChum.current = Math.max(0, untilChum.current - 1);
    return quote;
  }, [nextQuote]);

  return { pick, chumDeck };
}

/** The carousel: quotes and chumming photos from Slack in one rotation. Spotbot's photos are not in it (app/SpotAlert.tsx). */
function PhotoCarousel() {
  const chum = useChumPhotos();
  const deck = useQuoteDeck();
  const hasQuotes = deck.count > 0;
  const { failed, retry, markFailed } = useFailedPhotos();
  const { pick, chumDeck } = usePicker(deck.next, failed, hasQuotes);
  const [show, setShow] = useState<Show>({ previous: null, current: null, upcoming: null });
  const [rearm, setRearm] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const frame = useRef<HTMLDivElement>(null);
  // The same value as `show`, readable from timers, which outlive the render that started them.
  const showRef = useRef(show);
  /** When the current slide went up, on the performance clock. */
  const shownAt = useRef(0);

  const chumSlides = chum.filter((c) => !failed.has(chumKey(c.id)));
  const chumIdsKey = chum.map((c) => c.id).join(",");
  const chumLiveKey = chumSlides.map((c) => c.id).join(",");

  const commit = useCallback((next: Show) => {
    showRef.current = next;
    setShow(next);
  }, []);

  const putUp = useCallback((slide: Slide | null, previous: Slide | null) => {
    shownAt.current = performance.now();
    commit({ previous, current: slide, upcoming: slide ? pick(slide) : null });
  }, [commit, pick]);

  // The deck follows the list: a chumming photo that was not in the previous poll is the next one drawn.
  useEffect(() => {
    chumDeck.current?.sync(chumIdsKey ? chumIdsKey.split(",") : []);
  }, [chumIdsKey, chumDeck]);

  // Keep the show true to what there is: a slide whose photo left its list or failed, or a quote once there
  // are no quotes, is replaced; an empty turn is filled as soon as something can fill it.
  useEffect(() => {
    const liveChum = new Set(chumLiveKey ? chumLiveKey.split(",") : []);
    const usable = (slide: Slide | null) => slide !== null && (slide.kind === "chum" ? liveChum.has(slide.id) : hasQuotes);
    const { current, upcoming } = showRef.current;
    if (!usable(current)) {
      const first = usable(upcoming) ? upcoming : pick(null);
      if (first || current) putUp(first, null);
      return;
    }
    if (usable(upcoming)) return;
    const next = pick(current);
    if (next?.key !== upcoming?.key) commit({ ...showRef.current, upcoming: next });
  }, [chumLiveKey, hasQuotes, show, pick, putUp, commit]);

  // The clock: a plain timer per slide. The next slide goes up when the time is over and its picture is ready.
  const currentKey = show.current?.key ?? null;
  const upcomingKey = show.upcoming?.key ?? null;
  useEffect(() => {
    if (!currentKey || !upcomingKey) return;
    let timer: number | undefined;
    const turn = () => {
      const { current, upcoming } = showRef.current;
      if (!upcoming) return;
      if (slideReady(frame.current, upcoming)) return putUp(upcoming, current);
      if (performance.now() - shownAt.current < SLIDE_MS + SLIDE_LOAD_GRACE_MS) {
        timer = window.setTimeout(turn, SLIDE_READY_POLL_MS);
        return;
      }
      // Still loading: the slide on screen gets another turn and something else is lined up.
      shownAt.current = performance.now();
      commit({ ...showRef.current, upcoming: pick(current) });
      setRearm((n) => n + 1);
    };
    timer = window.setTimeout(turn, Math.max(0, shownAt.current + SLIDE_MS - performance.now()));
    return () => window.clearTimeout(timer);
  }, [currentKey, upcomingKey, rearm, putUp, pick, commit]);

  // A quote whose picture will not load is shown as its words; with no words either, it gives up its turn.
  const quoteImageFailed = useCallback((quote: Quote) => {
    const wordsOnly = (slide: Slide | null): Slide | null => {
      if (slide?.kind !== "quote" || slide.quote.id !== quote.id) return slide;
      return quote.text ? { ...slide, quote: { ...slide.quote, imageUrl: null, imageKind: null } } : null;
    };
    const { previous, current, upcoming } = showRef.current;
    const next = { previous: wordsOnly(previous), current: wordsOnly(current), upcoming: wordsOnly(upcoming) };
    if (current && !next.current) {
      shownAt.current = performance.now();
      commit({ previous: null, current: next.upcoming, upcoming: null });
      return;
    }
    commit(next);
  }, [commit]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(clock);
  }, []);

  if (!chum.length && !hasQuotes) {
    return (
      <section className="spot-card">
        <div className="spot-empty">{deck.status === "unconfigured" ? "Slack is not connected" : deck.status === "loading" ? "Checking Slack…" : "No quotes or chumming photos yet"}</div>
      </section>
    );
  }

  const quotes = quotesOnShow(show);
  return (
    <section className="spot-card">
      <div ref={frame} className="spot-image-frame">
        {chum.map((c) => {
          const key = chumKey(c.id);
          return (
            <img
              key={failed.has(key) ? `${key}:${retry}` : key}
              data-slide={key}
              src={c.imageUrl}
              alt={chumAlt(c)}
              aria-hidden={key !== currentKey}
              className={`spot-image ${key === currentKey ? "is-active" : ""}`}
              onLoad={() => markFailed(key, false)}
              onError={() => markFailed(key, true)}
            />
          );
        })}
        {quotes.map((slide) => (
          <div key={slide.key} data-slide={slide.key} className={`spot-image ${slide.key === currentKey ? "is-active" : ""}`} aria-hidden={slide.key !== currentKey}>
            <QuoteFrame quote={slide.quote} onImageError={quoteImageFailed} />
          </div>
        ))}
        {!chumSlides.length && !hasQuotes && <div className="spot-empty">Photo unavailable</div>}
      </div>
      <div className={`spot-caption ${hasQuotes ? "has-quotes" : ""}`}>
        {chumSlides.map((c) => {
          const key = chumKey(c.id);
          return (
            <div key={key} className={`spot-caption-item ${key === currentKey ? "is-active" : ""}`} aria-hidden={key !== currentKey}>
              <ChumCaption photo={c} now={now} />
            </div>
          );
        })}
        {quotes.map((slide) => (
          <div key={slide.key} className={`spot-caption-item ${slide.key === currentKey ? "is-active" : ""}`} aria-hidden={slide.key !== currentKey}>
            <QuoteCaption quote={slide.quote} now={now} />
          </div>
        ))}
      </div>
    </section>
  );
}

export default function Dashboard() {
  const spots = useSpotAlerts();
  // The calendar block is given room only while it has events to list (not while the calendar is unconnected or empty).
  const [hasEvents, setHasEvents] = useState(false);
  // Focus mode: only the ticker tape, the featured market and the calendar.
  const [focus, setFocus] = useState(false);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const response = await fetch("/api/focus", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { on?: boolean };
        if (alive) setFocus(body.on === true);
      } catch {
        // Stay as we are; the next poll tries again.
      }
    };
    poll();
    const timer = window.setInterval(poll, FOCUS_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const fit = () => document.documentElement.style.setProperty("--fit", String(Math.min(window.innerWidth / 1920, window.innerHeight / 1080)));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <MarketsProvider>
      <main className={`dashboard ${focus ? "is-focus" : ""}`}>
        <div className="top-row">
          <img className="brand-logo" src="/bab-logo.svg" alt="Blockchain at Berkeley" width={344} height={311} />
          <div className="tape-slot"><TickerTape /></div>
        </div>
        {!focus && (
          <div className="feed-slot">
            <div className="feed-box"><Feed /></div>
            <RecentSpots spots={spots.recent} now={spots.now} />
            <CoinFlip />
          </div>
        )}
        <div className="featured-slot"><FeaturedMarket /></div>
        <div className="side-slot">
          {!focus && <NowPlaying />}
          {!focus && <PhotoCarousel />}
          <div className={`events-slot ${hasEvents ? "is-open" : ""}`} aria-hidden={!hasEvents}>
            <div className="events-box">
              <Events quietWhenEmpty onState={({ count }) => setHasEvents(count > 0)} />
            </div>
          </div>
        </div>
        {!focus && <SpotTakeover spot={spots.takeover} now={spots.now} />}
      </main>
    </MarketsProvider>
  );
}
