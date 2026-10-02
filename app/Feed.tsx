"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { FeedItem, FeedResponse } from "@/lib/feed-types";
import { useFeaturedStory, type Story } from "./Markets";
import styles from "./Story.module.css";

/** How fast the list drifts downward, in stage pixels per second. The loop takes as long as the list is tall. */
export const FEED_SCROLL_PX_PER_S = 30;
/** With reduced motion the list does not move; it shows a screenful of whole items at a time, each for this long. */
export const FEED_PAGE_MS = 15_000;

const POLL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** How long the last list stays up while /api/feed is failing or returns nothing. */
const KEEP_LAST_MS = 6 * 60 * 60_000;
const CLOCK_MS = 30_000;
const MAX_ITEMS = 30;
/** A summary is shown only if its first sentence is no longer than this (three lines of the column). */
const SUMMARY_MAX_CHARS = 120;
const SUMMARY_MIN_CHARS = 40;
/** One copy of a list in the track. Scrolling shows two: the one on screen and, above it, the one that follows it. */
type Half = { key: number; items: FeedItem[] };
type Page = { from: number; to: number; top: number };
type Note = "loading" | "empty" | "error";

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/** The route's items are external content: keep only well-formed ones, once each. */
function clean(raw: unknown): FeedItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Partial<Record<keyof FeedItem, unknown>>;
    const id = text(item.id);
    const title = text(item.title);
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      kind: item.kind === "tweet" ? "tweet" : "news",
      source: text(item.source) ?? "",
      author: text(item.author),
      handle: text(item.handle),
      title,
      summary: text(item.summary),
      url: text(item.url) ?? "",
      publishedAt: text(item.publishedAt) ?? "",
      // Thumbnails are not shown: in a column this narrow they add load and noise without helping anyone read.
      imageUrl: null,
    });
    if (items.length === MAX_ITEMS) break;
  }
  return items;
}

function linkTarget(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Nobody can follow a link from across the room, and a long address wraps badly: a URL in the text is cut to its site. */
function shorten(value: string) {
  return value.replace(/https?:\/\/\S+/gi, (url) => {
    try {
      const parsed = new URL(url);
      return parsed.hostname.replace(/^www\./, "") + (parsed.pathname.length > 1 || parsed.search ? "/…" : "");
    } catch {
      return url;
    }
  });
}

/**
 * The summary's opening sentence, if that is short enough to be shown whole. Feeds send a paragraph; cut off
 * mid-thought under every headline it is noise, and a headline alone reads better from across the room.
 */
function lede(summary: string, title: string) {
  const body = shorten(summary);
  let stop = body.length;
  for (const mark of body.matchAll(/[.!?]["”’)]*(?=\s+["“‘(]?[A-Z])/g)) {
    const end = mark.index + mark[0].length;
    const word = body.slice(0, mark.index).split(/\s/).pop() ?? "";
    // Not a sentence end: an initial ("U.S.") or a title ("Dr.").
    if (end < SUMMARY_MIN_CHARS || /[A-Z]$/.test(word) || /^(Mr|Mrs|Ms|Dr|Prof|Sen|Rep|Gov|St|Jr|Sr|vs|No)$/.test(word)) continue;
    stop = end;
    break;
  }
  const sentence = body.slice(0, stop).trim();
  return sentence.length > SUMMARY_MAX_CHARS || sentence.toLowerCase() === title.toLowerCase() ? null : sentence;
}

function age(publishedAt: string, now: number) {
  const published = Date.parse(publishedAt);
  if (!Number.isFinite(published)) return null;
  const minutes = Math.floor((now - published) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 60 * 24 * 7) return `${Math.floor(minutes / (60 * 24))}d ago`;
  return new Date(published).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function Entry({ item, now, hidden }: { item: FeedItem; now: number; hidden: boolean }) {
  const tweet = item.kind === "tweet";
  const when = age(item.publishedAt, now);
  const handle = item.handle ? `@${item.handle.replace(/^@+/, "")}` : null;
  const summary = !tweet && item.summary ? lede(item.summary, item.title) : null;
  const who = tweet ? item.author ?? handle ?? item.source : item.source || item.author;
  return (
    <li className={tweet ? "feed-item is-tweet" : "feed-item"} style={hidden ? { visibility: "hidden" } : undefined}>
      {/* Nobody clicks on a TV, and focus would pull a moving item into view; it stays a link for assistive tech. */}
      <a className="feed-link" href={linkTarget(item.url)} target="_blank" rel="noopener noreferrer nofollow" tabIndex={-1}>
        <span className="feed-meta">
          {who && <span className="feed-source" dir="auto">{who}</span>}
          {tweet && item.author && handle && <span className="feed-handle">{handle}</span>}
          {when && <time className="feed-time" dateTime={new Date(Date.parse(item.publishedAt)).toISOString()}>{when}</time>}
        </span>
        <span className="feed-title" dir="auto">{shorten(item.title)}</span>
        {summary && <span className="feed-summary" dir="auto">{summary}</span>}
      </a>
    </li>
  );
}

/** The longest name that still fits the column at each size of the note's headline. */
const NOTE_NAME_SIZES: readonly [number, number][] = [[11, 76], [16, 60], [24, 48]];
const NOTE_NAME_MIN_PX = 40;

/**
 * The note on a newsworthy token: what happened, and which outlets reported it. The summary is written by a
 * model (lib/newsworthy.ts), so it is rendered as text and nothing else: no links, no markup.
 */
function Note({ story, on, now }: { story: Story; on: boolean; now: number }) {
  const { name, symbol } = story.asset;
  const size = NOTE_NAME_SIZES.find(([chars]) => name.length <= chars)?.[1] ?? NOTE_NAME_MIN_PX;
  const when = age(story.newestAt, now);
  return (
    <article className={on ? `${styles.story} ${styles.on}` : styles.story} aria-label={`${name} in the news`} aria-hidden={!on}>
      <p className={styles.kicker}><span className={styles.dot} aria-hidden="true" />In the news</p>
      <h2 className={styles.name} style={{ "--name-size": `${size}px` } as CSSProperties} dir="auto">{name}</h2>
      <p className={styles.symbol}>{symbol}</p>
      <p className={styles.summary} dir="auto">{story.summary}</p>
      <div className={styles.foot}>
        {story.outlets.length > 0 && (
          <p className={styles.outlets}><span className={styles.label}>Reported by</span>{story.outlets.join(", ")}</p>
        )}
        <p className={styles.credit}>AI summary{when ? ` · latest report ${when}` : ""}</p>
      </div>
    </article>
  );
}

/**
 * Curated news and posts from /api/feed, drifting slowly downward in a loop. Fills its container.
 *
 * While a newsworthy token is in the featured slot (see MarketsProvider) its note covers the list, and the
 * list stops moving underneath, so it carries on from the same place when the note goes.
 *
 * The track holds two copies of the list, the second drawn above the first (see .feed-track in globals.css).
 * It slides down by the height of the second, which leaves the second exactly where the first began; the
 * first is then dropped and a fresh copy added above. A new list from a poll goes into that fresh copy, which
 * is out of sight when it is added, so the content changes without a jump. A list short enough to fit is
 * shown still.
 */
export function Feed() {
  const [halves, setHalves] = useState<Half[]>([]);
  const [note, setNote] = useState<Note>("loading");
  const [now, setNow] = useState(() => Date.now());
  const [paging, setPaging] = useState<{ pages: Page[]; index: number }>({ pages: [], index: 0 });
  const reduced = useReducedMotion();
  const story = useFeaturedStory();
  const covered = story !== null;
  // The last note stays in the markup while it fades out.
  const [noted, setNoted] = useState<Story | null>(null);
  if (story && story !== noted) setNoted(story);

  const viewport = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const animation = useRef<Animation | null>(null);
  const halvesRef = useRef<Half[]>([]);
  const pending = useRef<FeedItem[] | null>(null);
  const keys = useRef(0);
  const signature = useRef("");
  const coveredRef = useRef(false);

  const commit = useCallback((next: Half[]) => {
    halvesRef.current = next;
    setHalves(next);
  }, []);

  const receive = useCallback((items: FeedItem[]) => {
    const incoming = items.map((i) => [i.id, i.title, i.summary ?? "", i.source, i.author ?? "", i.handle ?? ""].join("\u0000")).join("\u0001");
    if (incoming === signature.current) return;
    signature.current = incoming;
    const current = halvesRef.current;
    // Not scrolling (first list, a list that fits, or paged): nothing to keep in step with, so replace it.
    if (current.length < 2) { pending.current = null; commit([{ key: ++keys.current, items }]); return; }
    // The upper copy starts coming into view as soon as the slide does; the new list follows it instead.
    pending.current = items;
  }, [commit]);

  const clear = useCallback((why: Note) => {
    signature.current = "";
    pending.current = null;
    setNote(why);
    commit([]);
  }, [commit]);

  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | null = null;
    let lastGood = performance.now();

    const poll = async () => {
      request = new AbortController();
      const giveUp = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      let failure: Note | null = null;
      try {
        const response = await fetch("/api/feed", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Feed request failed");
        const body = (await response.json()) as Partial<FeedResponse> | null;
        if (!alive) return;
        const items = clean(body?.items);
        if (items.length) { lastGood = performance.now(); receive(items); }
        else failure = body?.status === "error" ? "error" : "empty";
      } catch {
        if (!alive) return;
        failure = "error";
      } finally {
        window.clearTimeout(giveUp);
      }
      // A failed or empty reply leaves the last list up; only when there is none, or it has gone stale, does the note show.
      if (failure && (!halvesRef.current.length || performance.now() - lastGood > KEEP_LAST_MS)) clear(failure);
      timer = window.setTimeout(poll, POLL_MS);
    };
    // Deferred so React's development double-mount does not send two requests.
    timer = window.setTimeout(poll, 0);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, [receive, clear]);

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => window.clearInterval(clock);
  }, []);

  const firstKey = halves[0]?.key ?? null;

  // Declared before the effect that starts a slide, so that one already knows whether to hold still.
  useLayoutEffect(() => {
    coveredRef.current = covered;
    const run = animation.current;
    if (!run) return;
    if (covered) run.pause();
    else if (run.playState === "paused") run.play();
  }, [covered]);

  // Runs once per copy that reaches the top: measures the copy above it and starts the slide. Re-measures if a
  // height changes (web fonts arriving), carrying on from the same pixel.
  useLayoutEffect(() => {
    const strip = track.current;
    const view = viewport.current;
    const first = strip?.firstElementChild as HTMLElement | null;
    if (!strip || !view || !first || firstKey === null) return;
    let measured = -1;

    const stop = () => {
      const run = animation.current;
      animation.current = null;
      if (run) { run.onfinish = null; run.cancel(); }
    };

    const wrap = () => {
      const current = halvesRef.current;
      if (current.length < 2) return;
      const items = pending.current ?? current[1].items;
      pending.current = null;
      commit([current[1], { key: ++keys.current, items }]);
    };

    const sync = () => {
      const height = first.offsetHeight;
      const room = view.clientHeight;
      if (reduced || height <= room) {
        stop();
        measured = -1;
        const current = halvesRef.current;
        if (current.length > 1) {
          // Down to one copy: the newest list there is.
          const waiting = pending.current;
          pending.current = null;
          commit([waiting ? { key: ++keys.current, items: waiting } : current[1]]);
        }
        if (!reduced) { setPaging((p) => (p.pages.length ? { pages: [], index: 0 } : p)); return; }
        // Whole items only: a page ends before the first item that would be cut off.
        const kids = [...first.children] as HTMLElement[];
        const pages: Page[] = [];
        let from = 0;
        kids.forEach((kid, i) => {
          if (i > from && kid.offsetTop + kid.offsetHeight - kids[from].offsetTop > room) {
            pages.push({ from, to: i - 1, top: kids[from].offsetTop });
            from = i;
          }
        });
        if (kids.length) pages.push({ from, to: kids.length - 1, top: kids[from].offsetTop });
        setPaging((p) => (JSON.stringify(p.pages) === JSON.stringify(pages) ? p : { pages, index: 0 }));
        return;
      }
      setPaging((p) => (p.pages.length ? { pages: [], index: 0 } : p));
      const current = halvesRef.current;
      if (current.length < 2) commit([current[0], { key: ++keys.current, items: current[0].items }]);
      // The copy above is what slides in. On the pass that adds it, it is not in the track yet: it is the same list.
      const travel = strip.children.length > 1 ? (strip.lastElementChild as HTMLElement).offsetHeight : height;
      if (travel === measured && animation.current) return;
      measured = travel;
      const elapsed = Number(animation.current?.currentTime) || 0;
      stop();
      const duration = (travel / FEED_SCROLL_PX_PER_S) * 1000;
      const run = strip.animate(
        [{ transform: `translate3d(0, ${-travel}px, 0)` }, { transform: "translate3d(0, 0, 0)" }],
        { duration, easing: "linear", fill: "forwards" },
      );
      run.currentTime = Math.min(elapsed, duration);
      if (coveredRef.current) run.pause();
      run.onfinish = wrap;
      animation.current = run;
    };

    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(strip);
    return () => { observer.disconnect(); stop(); };
  }, [firstKey, reduced, commit]);

  const pageCount = paging.pages.length;
  useEffect(() => {
    if (pageCount < 2) return;
    const timer = window.setInterval(() => setPaging((p) => ({ pages: p.pages, index: (p.index + 1) % p.pages.length })), FEED_PAGE_MS);
    return () => window.clearInterval(timer);
  }, [pageCount]);

  const page = pageCount ? paging.pages[Math.min(paging.index, pageCount - 1)] : null;
  const list = !halves.length ? (
    <section className="feed" aria-label="News and posts">
      <p className="feed-note">{note === "loading" ? "Loading news…" : note === "error" ? "News unavailable" : "No news right now"}</p>
    </section>
  ) : (
    <section className={`feed ${halves.length > 1 ? "is-scrolling" : ""}`} aria-label="News and posts">
      <div ref={viewport} className="feed-viewport">
        <div ref={track} className="feed-track" style={page ? { transform: `translate3d(0, ${-page.top}px, 0)` } : undefined}>
          {halves.map((half, at) => (
            <ol key={half.key} className="feed-group" aria-hidden={at > 0}>
              {half.items.map((item, i) => (
                <Entry key={item.id} item={item} now={now} hidden={page !== null && (i < page.from || i > page.to)} />
              ))}
            </ol>
          ))}
        </div>
      </div>
    </section>
  );

  return (
    <div className={styles.column}>
      <div className={covered ? `${styles.layer} ${styles.away}` : styles.layer} aria-hidden={covered || undefined}>{list}</div>
      {noted && <Note story={noted} on={covered} now={now} />}
    </div>
  );
}
