"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { ScreenState } from "../lib/screen-state";
import { ChumCaption, chumAlt, createChumDeck, useChumPhotos, type ChumDeck } from "./Chum";
import { CoinFlip } from "./CoinFlip";
import { Events } from "./Events";
import { Feed } from "./Feed";
import { Game } from "./Game";
import { Leaderboard } from "./Leaderboard";
import { FeaturedMarket, MarketsProvider, TickerTape } from "./Markets";
import { NowPlaying } from "./NowPlaying";
import { Overlays } from "./Overlay";
import { PinnedThread } from "./PinnedThread";
import { QuoteCaption, QuoteFrame, useQuoteDeck, type Quote } from "./Quotes";
import { PRESET_LAYOUTS, SLOTS, WIDGETS, fits, isWidgetId, type Layout, type WidgetId } from "./widgets/registry";
import widgetStyles from "./widgets/Widgets.module.css";

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

/** How long each slide of the carousel stays up. */
const SLIDE_MS = 8_000;
/** A slide whose picture is still loading when its turn comes is waited for this long, then passed over. */
const SLIDE_LOAD_GRACE_MS = 6_000;
const SLIDE_READY_POLL_MS = 250;
const SPOT_RETRY_MS = 5 * 60_000;
/** Quotes drawn in a row while looking for one that has something to show. */
const QUOTE_DRAWS = 6;
/** A chumming photo follows this many spots and quotes: two or three, at random, so about two slides in seven. */
const chumGap = () => 2 + Math.floor(Math.random() * 2);
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

// One turn of the carousel: a spotted photo or a chumming photo (by id, so it follows the list as polls replace
// it), or a quote.
type Slide =
  | { kind: "spot"; key: string; id: string }
  | { kind: "chum"; key: string; id: string }
  | { kind: "quote"; key: string; quote: Quote };
// `upcoming` is chosen a whole turn ahead and mounted hidden, so its picture has loaded before the crossfade;
// `previous` stays mounted so it can fade out.
type Show = { previous: Slide | null; current: Slide | null; upcoming: Slide | null };

const spotSlide = (id: string): Slide => ({ kind: "spot", key: `spot:${id}`, id });
const chumSlide = (id: string): Slide => ({ kind: "chum", key: `chum:${id}`, id });
const spotKey = (id: string) => `spot:${id}`;
const chumKey = (id: string) => `chum:${id}`;
const quoteSlide = (quote: Quote): Slide => ({ kind: "quote", key: `quote:${quote.id}`, quote });

/**
 * The carousel: spotted photos, quotes and chumming photos in one rotation. Spots and quotes are the backbone:
 * while both exist they alternate, the six newest spots in order and the quotes at random from the deck; with
 * only one of them, it cycles on its own. A chumming photo is slipped in after every two or three of those (at
 * random), in shuffled order through all six before any comes back, and never two in a row unless chumming
 * photos are all there is.
 */
function SpotCard({ spot, loading }: { spot: SpotResponse | null; loading: boolean }) {
  const spots = spot?.spots ?? [];
  const chum = useChumPhotos();
  const deck = useQuoteDeck();
  const [show, setShow] = useState<Show>({ previous: null, current: null, upcoming: null });
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [retry, setRetry] = useState(0);
  const [rearm, setRearm] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const frame = useRef<HTMLDivElement>(null);
  const knownIds = useRef<Set<string> | null>(null);
  // The same value as `show`, readable from timers, which outlive the render that started them.
  const showRef = useRef(show);
  /** When the current slide went up, on the performance clock. */
  const shownAt = useRef(0);
  /** The spot most recently given a turn: the rotation carries on from the one after it. */
  const lastSpotId = useRef<string | null>(null);
  const chumDeck = useRef<ChumDeck | null>(null);
  if (chumDeck.current === null) chumDeck.current = createChumDeck();
  /** Spots and quotes still to pick before the next chumming photo. */
  const untilChum = useRef(-1);
  if (untilChum.current < 0) untilChum.current = chumGap();
  /** What was up before the chumming photo, so the spots and quotes take turns across it. */
  const kindBeforeChum = useRef<"spot" | "quote" | null>(null);

  // Photos that failed to load stay mounted (hidden) so they can be retried, but drop out of the rotation.
  // `failed` holds slide keys, of spots and chumming photos alike.
  const slides = spots.filter((s) => !failed.has(spotKey(s.id)));
  const chumSlides = chum.filter((c) => !failed.has(chumKey(c.id)));
  const newestId = spots[0]?.id ?? null;
  const idsKey = spots.map((s) => s.id).join(",");
  const liveKey = slides.map((s) => s.id).join(",");
  const chumIdsKey = chum.map((c) => c.id).join(",");
  const chumLiveKey = chumSlides.map((c) => c.id).join(",");
  const anyFailed = failed.size > 0;
  const hasQuotes = deck.count > 0;
  const nextQuote = deck.next;
  const pool = useRef({ spots, failed, hasQuotes });
  pool.current = { spots, failed, hasQuotes };

  const markFailed = (key: string, bad: boolean) => setFailed((prev) => {
    if (prev.has(key) === bad) return prev;
    const next = new Set(prev);
    if (bad) next.add(key); else next.delete(key);
    return next;
  });

  const commit = useCallback((next: Show) => {
    showRef.current = next;
    setShow(next);
  }, []);

  /** What follows `after`. Takes a quote from the deck, so it is only ever called from an effect or a timer. */
  const pick = useCallback((after: Slide | null): Slide | null => {
    const { spots: all, failed: bad, hasQuotes: quotes } = pool.current;
    const spotAfter = (): Slide | null => {
      const at = all.findIndex((s) => s.id === lastSpotId.current);
      for (let step = 1; step <= all.length; step += 1) {
        const candidate = all[(at + step) % all.length];
        if (bad.has(spotKey(candidate.id))) continue;
        // Back at the photo that is already up: there is no other.
        if (after?.kind === "spot" && after.id === candidate.id) return null;
        lastSpotId.current = candidate.id;
        return spotSlide(candidate.id);
      }
      return null;
    };
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
      if (after?.kind !== "chum") kindBeforeChum.current = after?.kind ?? null;
      untilChum.current = chumGap();
      return chumSlide(id);
    };
    // Spots and quotes alternate while both exist, carrying on across a chumming photo; the very first slide is
    // the newest spot.
    const before = after?.kind === "chum" ? kindBeforeChum.current : after?.kind ?? null;
    const backbone = () => (before === "spot" ? quoteAfter() ?? spotAfter() : spotAfter() ?? quoteAfter());
    // A chumming photo when one is due, but never straight after another while there is anything else.
    if (after?.kind !== "chum" && untilChum.current <= 0) {
      const due = chumAfter();
      if (due) return due;
    }
    const slide = backbone();
    if (!slide) return chumAfter();
    untilChum.current = Math.max(0, untilChum.current - 1);
    return slide;
  }, [nextQuote]);

  /** Lines up `next` in place of what was going to follow. A chumming photo that loses its turn gets the next one. */
  const lineUp = useCallback((next: Slide | null) => {
    const { upcoming } = showRef.current;
    if (upcoming?.kind === "chum" && upcoming.key !== next?.key) {
      chumDeck.current?.putBack(upcoming.id);
      untilChum.current = 0;
    }
    commit({ ...showRef.current, upcoming: next });
  }, [commit]);

  const putUp = useCallback((slide: Slide | null, previous: Slide | null) => {
    shownAt.current = performance.now();
    commit({ previous, current: slide, upcoming: slide ? pick(slide) : null });
  }, [commit, pick]);

  // When a poll brings a spot that was not in the previous list, it goes up next, and as soon as its photo has loaded.
  useEffect(() => {
    const previous = knownIds.current;
    knownIds.current = new Set(idsKey ? idsKey.split(",") : []);
    const { current } = showRef.current;
    if (!previous || !newestId || previous.has(newestId) || !current) return;
    lastSpotId.current = newestId;
    shownAt.current = performance.now() - SLIDE_MS;
    lineUp(spotSlide(newestId));
  }, [idsKey, newestId, lineUp]);

  // The deck follows the list: a chumming photo that was not in the previous poll is the next one drawn.
  useEffect(() => {
    chumDeck.current?.sync(chumIdsKey ? chumIdsKey.split(",") : []);
  }, [chumIdsKey]);

  // Keep the show true to what there is: a slide whose photo left its list or failed, or a quote once there
  // are no quotes, is replaced; an empty turn is filled as soon as something can fill it.
  useEffect(() => {
    const live = new Set(liveKey ? liveKey.split(",") : []);
    const liveChum = new Set(chumLiveKey ? chumLiveKey.split(",") : []);
    const usable = (slide: Slide | null) =>
      slide !== null && (slide.kind === "spot" ? live.has(slide.id) : slide.kind === "chum" ? liveChum.has(slide.id) : hasQuotes);
    const { current, upcoming } = showRef.current;
    // Nothing goes up before the spots have answered, so the show opens on the newest spot when there is one.
    if (!current && loading) return;
    if (!usable(current)) {
      const first = usable(upcoming) ? upcoming : pick(null);
      if (first || current) putUp(first, null);
    } else if (!usable(upcoming)) {
      const next = pick(current);
      if (next?.key !== upcoming?.key) commit({ ...showRef.current, upcoming: next });
    } else if (current?.kind === "chum" && upcoming?.kind === "chum" && (live.size > 0 || hasQuotes)) {
      // Two chumming photos were lined up while they were all there was (the first seconds after loading).
      const next = pick(current);
      if (next && next.kind !== "chum") lineUp(next);
      else if (next) chumDeck.current?.putBack(next.id);
    }
  }, [liveKey, chumLiveKey, hasQuotes, loading, show, pick, putUp, commit, lineUp]);

  // The clock: a plain timer per slide. The next slide goes up when the time is over and its picture is ready.
  const currentKey = show.current?.key ?? null;
  const upcomingKey = show.upcoming?.key ?? null;
  useEffect(() => {
    if (!currentKey || !upcomingKey) return;
    let timer: number | undefined;
    const ready = (slide: Slide) => {
      const layer = frame.current?.querySelector<HTMLElement>(`[data-slide="${CSS.escape(slide.key)}"]`);
      if (!layer) return false;
      const image = layer instanceof HTMLImageElement ? layer : layer.querySelector("img");
      return !image || (image.complete && image.naturalWidth > 0);
    };
    const turn = () => {
      const { current, upcoming } = showRef.current;
      if (!upcoming) return;
      if (ready(upcoming)) {
        putUp(upcoming, current);
      } else if (performance.now() - shownAt.current < SLIDE_MS + SLIDE_LOAD_GRACE_MS) {
        timer = window.setTimeout(turn, SLIDE_READY_POLL_MS);
      } else {
        // Still loading: the slide on screen gets another turn and something else is lined up.
        // (A chumming photo passed over this way waits for the deck's next pass rather than being handed back.)
        shownAt.current = performance.now();
        commit({ ...showRef.current, upcoming: pick(current) });
        setRearm((n) => n + 1);
      }
    };
    timer = window.setTimeout(turn, Math.max(0, shownAt.current + SLIDE_MS - performance.now()));
    return () => window.clearTimeout(timer);
  }, [currentKey, upcomingKey, rearm, putUp, pick, commit]);

  // A quote whose picture will not load is shown as its words; with no words either, it gives up its turn.
  const quoteImageFailed = useCallback((quote: Quote) => {
    const wordsOnly = (slide: Slide | null): Slide | null =>
      slide?.kind === "quote" && slide.quote.id === quote.id
        ? quote.text ? { ...slide, quote: { ...slide.quote, imageUrl: null, imageKind: null } } : null
        : slide;
    const { previous, current, upcoming } = showRef.current;
    const next = { previous: wordsOnly(previous), current: wordsOnly(current), upcoming: wordsOnly(upcoming) };
    if (current && !next.current) {
      shownAt.current = performance.now();
      commit({ previous: null, current: next.upcoming, upcoming: null });
    } else {
      commit(next);
    }
  }, [commit]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!anyFailed) return;
    const timer = window.setInterval(() => setRetry((n) => n + 1), SPOT_RETRY_MS);
    return () => window.clearInterval(timer);
  }, [anyFailed]);

  if (!spots.length && !chum.length && !hasQuotes) {
    return (
      <section className="spot-card">
        <div className="spot-empty">{spot?.status === "unconfigured" ? "Slack is not connected" : loading ? "Checking Slack…" : "No sighting yet"}</div>
      </section>
    );
  }

  const quotes: Array<Extract<Slide, { kind: "quote" }>> = [];
  for (const slide of [show.previous, show.current, show.upcoming]) {
    if (slide?.kind === "quote" && !quotes.some((q) => q.key === slide.key)) quotes.push(slide);
  }

  return (
    <section className="spot-card">
      <div ref={frame} className="spot-image-frame">
        {spots.map((s) => {
          const who = s.spotted.length ? nameList.format(s.spotted) : null;
          const alt = [who ? `Photo of ${who}` : s.text?.trim() || "Spotted photo", s.spotter && `spotted by ${s.spotter}`].filter(Boolean).join(", ");
          const key = spotKey(s.id);
          return (
            <img
              key={failed.has(key) ? `${key}:${retry}` : key}
              data-slide={key}
              src={s.imageUrl}
              alt={alt}
              aria-hidden={key !== currentKey}
              className={`spot-image ${key === currentKey ? "is-active" : ""}`}
              onLoad={() => markFailed(key, false)}
              onError={() => markFailed(key, true)}
            />
          );
        })}
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
        {!slides.length && !chumSlides.length && !hasQuotes && <div className="spot-empty">Photo unavailable</div>}
      </div>
      <div className={`spot-caption ${hasQuotes ? "has-quotes" : ""}`}>
        {slides.map((s) => {
          const note = spotNote(s);
          const age = spotAge(s.postedAt, now);
          const key = spotKey(s.id);
          return (
            <div key={key} className={`spot-caption-item ${key === currentKey ? "is-active" : ""}`} aria-hidden={key !== currentKey}>
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

/** Wait this long before reconnecting to the screen stream after it drops. */
const STREAM_RETRY_MS = 3_000;
/** Out of touch with the server this long, the page goes back to the default layout with no overlays. */
const STREAM_FALLBACK_MS = 60_000;

/**
 * What the server says the screen shows (lib/screen-state.ts), from one EventSource on /api/screen/stream; null
 * until the first message, and again after a long drop, which the page treats as the default preset. A short
 * drop keeps the last layout up while it reconnects.
 */
function useScreenState(): ScreenState | null {
  const [state, setState] = useState<ScreenState | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let fallback: number | undefined;
    // Within one connection a state older than the last one (sent on connect while a change was going out) is
    // ignored; a new connection starts over, since the server may have started over too.
    let version = -1;

    const connect = () => {
      version = -1;
      source = new EventSource("/api/screen/stream");
      source.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as ScreenState;
          if (typeof next?.version !== "number" || next.version < version) return;
          version = next.version;
          window.clearTimeout(fallback);
          fallback = undefined;
          setState(next);
        } catch {
          // Not a state: ignore it, the next change sends the whole state again.
        }
      };
      // EventSource retries by itself after a dropped connection, but not after an error status; closing and
      // opening a new one covers both.
      source.onerror = () => {
        source?.close();
        window.clearTimeout(retry);
        retry = window.setTimeout(connect, STREAM_RETRY_MS);
        fallback ??= window.setTimeout(() => setState(null), STREAM_FALLBACK_MS);
      };
    };

    connect();
    return () => {
      source?.close();
      window.clearTimeout(retry);
      window.clearTimeout(fallback);
    };
  }, []);

  return state;
}

/** Whether a widget that needs data has some to show. */
function hasData(widget: WidgetId, state: ScreenState | null): boolean {
  if (widget === "leaderboard") return Boolean(state?.leaderboard?.rows.length);
  if (widget === "pinned_thread") return Boolean(state?.pinnedThread);
  if (widget === "game") return Boolean(state?.game);
  return true;
}

/**
 * The widget each slot shows. Anything the page does not know or that does not fit, and a widget with nothing to
 * show (no leaderboard, no pinned thread), gives the slot back to what the default preset puts there.
 */
function resolveLayout(state: ScreenState | null): Layout {
  const fallback = PRESET_LAYOUTS.default;
  const layout = { ...fallback };
  for (const slot of SLOTS) {
    const widget: unknown = state?.slots?.[slot];
    if (!isWidgetId(widget) || !fits(widget, slot)) continue;
    if (WIDGETS[widget].needsData && !hasData(widget, state)) continue;
    layout[slot] = widget;
  }
  return layout;
}

export default function Dashboard() {
  const [spot, setSpot] = useState<SpotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  // The calendar block is given room only while it has events to list (not while the calendar is unconnected or empty).
  const [hasEvents, setHasEvents] = useState(false);
  const screen = useScreenState();
  const layout = resolveLayout(screen);

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

  /**
   * A widget for one of the slots that fill a box. The one the default preset puts there (`home`) is drawn bare,
   * exactly as it always was; anything else goes in a box that fills the slot.
   */
  const widget = (id: WidgetId, home: WidgetId): ReactNode => {
    let node: ReactNode;
    switch (id) {
      case "feed": node = <Feed />; break;
      case "carousel": node = <SpotCard spot={spot} loading={loading} />; break;
      case "featured_market": node = <FeaturedMarket />; break;
      case "events": node = <Events />; break;
      case "leaderboard": node = screen?.leaderboard ? <Leaderboard board={screen.leaderboard} /> : null; break;
      case "pinned_thread": node = screen?.pinnedThread ? <PinnedThread thread={screen.pinnedThread} /> : null; break;
      case "game": node = screen?.game ? <Game game={screen.game} /> : null; break;
      default: node = null;
    }
    if (id === home) return node;
    return <div key={id} className={widgetStyles.fill}>{node}</div>;
  };

  return (
    <MarketsProvider>
      <main className="dashboard">
        <div className="top-row">
          <img className="brand-logo" src="/bab-logo.svg" alt="Blockchain at Berkeley" width={344} height={311} />
          <div className="tape-slot">{layout.tape === "ticker" && <TickerTape />}</div>
        </div>
        <div className="feed-slot">
          <div className="feed-box">{widget(layout.left, "feed")}</div>
          {layout.left_bottom === "coin_flip" && <CoinFlip />}
        </div>
        <div className="featured-slot">{widget(layout.center, "featured_market")}</div>
        <div className="side-slot">
          {layout.side_top === "now_playing" && <NowPlaying />}
          {widget(layout.side, "carousel")}
          {layout.side_bottom === "events" && (
            <div className={`events-slot ${hasEvents ? "is-open" : ""}`} aria-hidden={!hasEvents}>
              <div className="events-box">
                <Events quietWhenEmpty onState={({ count }) => setHasEvents(count > 0)} />
              </div>
            </div>
          )}
        </div>
        <Overlays overlays={screen?.overlays ?? []} />
      </main>
    </MarketsProvider>
  );
}
