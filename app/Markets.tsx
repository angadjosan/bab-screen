"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NewsworthyResponse, NewsworthyToken } from "@/lib/feed-types";
import { HL_WS_URL, SET_ASSETS, fetchGateQuotes, fetchHyperliquidQuotes, formatChange, formatPrice, makeAsset, quoteFromCtx, type Asset, type Quote, type Quotes, type Venue } from "@/lib/markets";
import { CandleChart } from "./CandleChart";
import styles from "./Markets.module.css";

/** How long a set token stays in the featured slot. */
export const FEATURE_MS = 10_000;
/** How long a newsworthy token stays: long enough to read its note from across the room. */
export const NEWS_FEATURE_MS = 20_000;
/** The rotation shows this many set tokens, then one newsworthy token, and so on. */
export const SETS_PER_NEWS = 2;
/** On-screen prices change at most this often, however fast the feed is. */
export const PRICE_FLUSH_MS = 3_000;
/** Tape speed: one full loop takes this long per listed market (about 150 px/s at 1080p). */
export const TAPE_SECONDS_PER_ITEM = 2.5;

// A quote older than this is not shown; with none left the components fall back to "unavailable".
const STALE_MS = 60_000;
const LOADING_GRACE_MS = 10_000;
/** A chart that has not loaded after this long is given up on, and its market left out of the rotation ... */
const CHART_TIMEOUT_MS = 30_000;
/** ... until this much later. */
const CHART_RETRY_MS = 10 * 60_000;
const REST_POLL_MS = 30_000;
const REST_RETRY_MIN_MS = 5_000;
const REST_REFRESH_MS = 5 * 60_000;
/** Gate has no socket here: its markets are asked for this often (one request each; its limit is 200 per 10 seconds). */
const GATE_POLL_MS = 15_000;
const NEWS_POLL_MS = 60_000;
const NEWS_REQUEST_TIMEOUT_MS = 20_000;
/** How long the last list of newsworthy tokens is kept while /api/newsworthy cannot be reached. */
const NEWS_KEEP_MS = 30 * 60_000;
const NEWS_MAX_TOKENS = 8;
const NEWS_SUMMARY_MAX_CHARS = 280;
const WS_PING_MS = 20_000;
const WS_SILENT_MS = 45_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_RETRY_MIN_MS = 1_000;
const WS_RETRY_MAX_MS = 30_000;
const TAPE_MIN_ITEMS = 12;
/** In a header too wide for its column, the market's name shrinks no further than this before the price does. */
const NAME_MIN_SCALE = 0.5;

type Status = "loading" | "live" | "unavailable";
type View = { status: Status; quotes: Record<string, Quote> };
/** A newsworthy token: its market, and the note shown in the feed column while it is featured. */
export type Story = { asset: Asset; summary: string; outlets: string[]; newestAt: string };
/** What is in the featured slot, and where the two lists stand. */
type Turn = {
  asset: Asset;
  /** The note that goes with it; null for a set token. */
  story: Story | null;
  /** The set token and the newsworthy token shown most recently; each list carries on from there. */
  lastSet: string | null;
  lastNews: string | null;
  /** Set tokens shown since the last newsworthy one. */
  setsSinceNews: number;
};
type Markets = {
  status: Status;
  /** Tracked markets that currently have a fresh quote, in tape order: the set tokens, then the newsworthy ones. */
  assets: Asset[];
  quotes: Record<string, Quote>;
  featured: Asset;
  /** The featured market's note, when it is a newsworthy token. */
  story: Story | null;
  /** The market that takes the featured slot next; its chart loads out of sight meanwhile. */
  next: Asset | null;
  /** Called by the chart: `ok` once a market's chart is ready to show, otherwise it could not be loaded. */
  chartLoaded: (coin: string, ok: boolean) => void;
};

const MarketsContext = createContext<Markets | null>(null);
const SET_COINS = new Set(SET_ASSETS.map((a) => a.coin));
const SET_SYMBOLS = new Set(SET_ASSETS.map((a) => a.symbol));

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() && value.trim().length <= max ? value.trim() : null);

/** The route's tokens, checked again: well-formed, on a venue this page can read, and not a set token. */
function cleanStories(raw: unknown): Story[] {
  if (!Array.isArray(raw)) return [];
  const stories: Story[] = [];
  for (const entry of raw) {
    const story = cleanStory(entry, stories);
    if (!story) continue;
    stories.push(story);
    if (stories.length === NEWS_MAX_TOKENS) break;
  }
  return stories;
}

type RawToken = Partial<Record<keyof NewsworthyToken, unknown>>;

/** One route token as a story, or null when it is malformed, a set token, or already in `kept`. */
function cleanStory(entry: unknown, kept: Story[]): Story | null {
  if (!entry || typeof entry !== "object") return null;
  const token = entry as RawToken;
  const fields = storyFields(token);
  if (!fields) return null;
  const { symbol, summary } = fields;
  const asset = makeAsset(fields.venue, fields.market, symbol, fields.name, Number(token.lot));
  if (!asset || SET_COINS.has(asset.coin) || SET_SYMBOLS.has(symbol) || kept.some((s) => s.asset.coin === asset.coin)) return null;
  const outlets = storyOutlets(token.outlets);
  return { asset, summary, outlets, newestAt: text(token.newestAt, 40) ?? "" };
}

function storyFields(token: RawToken): { symbol: string; name: string; market: string; summary: string; venue: Venue } | null {
  const symbol = text(token.symbol, 12);
  const name = text(token.name, 48);
  const market = text(token.market, 24);
  const summary = text(token.summary, NEWS_SUMMARY_MAX_CHARS);
  if (!symbol || !name || !market || !summary || (token.venue !== "hyperliquid" && token.venue !== "gate")) return null;
  return { symbol, name, market, summary, venue: token.venue };
}

function storyOutlets(outlets: unknown): string[] {
  return Array.isArray(outlets) ? outlets.map((outlet) => text(outlet, 40)).filter((outlet): outlet is string => outlet !== null).slice(0, 4) : [];
}

/** `list` in the order it is next due: starting after the entry shown last, which comes round at the end. */
function after<T>(list: readonly T[], coin: (entry: T) => string, last: string | null): T[] {
  const at = list.findIndex((entry) => coin(entry) === last);
  return at < 0 ? [...list] : [...list.slice(at + 1), ...list.slice(0, at + 1)];
}

function useMarkets() {
  const markets = useContext(MarketsContext);
  if (!markets) throw new Error("TickerTape and FeaturedMarket must be rendered inside <MarketsProvider>");
  return markets;
}

/** The note for the token in the featured slot, or null while a set token (or nothing) is there. */
export function useFeaturedStory(): Story | null {
  const markets = useMarkets();
  return markets.status === "live" ? markets.story : null;
}

export function MarketsProvider({ children, featureMs = FEATURE_MS, newsFeatureMs = NEWS_FEATURE_MS }: { children: ReactNode; featureMs?: number; newsFeatureMs?: number }) {
  const quotesRef = useRef(new Map<string, Quote>());
  const delistedRef = useRef(new Set<string>());
  /** Every market being tracked, by coin; the price loop reads it afresh each time it acts. */
  const trackedRef = useRef(new Map<string, Asset>());
  /** Tells the price loop that the tracked markets have changed. */
  const retrackRef = useRef<(() => void) | null>(null);
  const [view, setView] = useState<View>({ status: "loading", quotes: {} });
  const [stories, setStories] = useState<readonly Story[]>([]);
  const [turn, setTurn] = useState<Turn>({ asset: SET_ASSETS[0], story: null, lastSet: SET_ASSETS[0].coin, lastNews: null, setsSinceNews: 1 });
  /** The dwell is over: swap as soon as the next chart is ready. */
  const [due, setDue] = useState(false);
  /** Markets whose chart has loaded since the last swap. */
  const [ready, setReady] = useState<readonly string[]>([]);
  /** Markets whose chart would not load, and when. */
  const [failed, setFailed] = useState<Record<string, number>>({});

  // The newsworthy tokens come from the server, which makes the list in the background; this only reads it.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | null = null;
    let signature = "";
    let lastGood = performance.now();

    const poll = async () => {
      request = new AbortController();
      const giveUp = window.setTimeout(() => request?.abort(), NEWS_REQUEST_TIMEOUT_MS);
      let list: Story[] | null = null;
      try {
        const response = await fetch("/api/newsworthy", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Newsworthy request failed");
        const body = (await response.json()) as Partial<NewsworthyResponse> | null;
        if (!alive) return;
        // An error reply says nothing about the news; "ok", "empty" and "off" are answers.
        if (body?.status !== "error") { list = cleanStories(body?.tokens); lastGood = performance.now(); }
      } catch {
        if (!alive) return;
      } finally {
        window.clearTimeout(giveUp);
      }
      // Unreachable: the last list stays for a while, then the screen goes back to set tokens and the feed.
      if (!list && performance.now() - lastGood > NEWS_KEEP_MS) list = [];
      if (list) {
        const incoming = JSON.stringify(list);
        if (incoming !== signature) { signature = incoming; setStories(list); }
      }
      timer = window.setTimeout(poll, NEWS_POLL_MS);
    };
    // Deferred so React's development double-mount does not send two requests.
    timer = window.setTimeout(poll, 0);

    return () => {
      alive = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, []);

  // Set tokens first, then the newsworthy ones: the tape's order. The featured market stays tracked until it
  // leaves the slot, even if the list it came from has dropped it meanwhile.
  const tracked = useMemo(() => {
    const list = [...SET_ASSETS, ...stories.map((s) => s.asset)];
    return list.some((a) => a.coin === turn.asset.coin) ? list : [...list, turn.asset];
  }, [stories, turn.asset]);

  useEffect(() => {
    trackedRef.current = new Map(tracked.map((a) => [a.coin, a]));
    retrackRef.current?.();
  }, [tracked]);

  // One WebSocket carries every Hyperliquid price; REST seeds the first paint, fills in while the socket is down,
  // and catches delistings. Gate's markets are polled.
  useEffect(() => {
    const quotes = quotesRef.current;
    const delisted = delistedRef.current;
    const tracking = () => [...trackedRef.current.values()];
    const startedAt = Date.now();
    let closed = false;
    let hadData = false;
    let socket: WebSocket | null = null;
    /** Coins the open socket is subscribed to. */
    let subscribed = new Set<string>();
    let backoff = WS_RETRY_MIN_MS;
    let lastMessageAt = 0;
    let lastRestAt = 0;
    let nextRestAt = 0;
    let restFailures = 0;
    let restBusy = false;
    let restAgain = false;
    let gateBusy = false;
    let retryTimer: number | undefined;

    const publish = () => {
      const now = Date.now();
      const fresh: Record<string, Quote> = {};
      for (const [coin, quote] of quotes) if (now - quote.at < STALE_MS && !delisted.has(coin) && trackedRef.current.has(coin)) fresh[coin] = quote;
      const any = Object.keys(fresh).length > 0;
      if (any) hadData = true;
      setView({ status: any ? "live" : hadData || now - startedAt > LOADING_GRACE_MS ? "unavailable" : "loading", quotes: fresh });
    };

    const take = (result: Quotes) => {
      for (const [coin, quote] of result.quotes) {
        delisted.delete(coin);
        const current = quotes.get(coin);
        if (!current || current.at < quote.at) quotes.set(coin, quote);
      }
      for (const coin of result.delisted) { delisted.add(coin); quotes.delete(coin); }
    };

    const refresh = async () => {
      // Asked for again while one is in flight (a token was just added): go round once more afterwards.
      if (restBusy) { restAgain = true; return; }
      restBusy = true;
      try {
        const result = await fetchHyperliquidQuotes(tracking());
        if (closed) return;
        take(result);
        lastRestAt = Date.now();
        nextRestAt = lastRestAt + REST_POLL_MS;
        restFailures = 0;
        if (!hadData) publish();
      } catch {
        // Unreachable: quotes age out and the next poll tries again, backing off from 5 to 30 seconds.
        nextRestAt = Date.now() + Math.min(REST_POLL_MS, REST_RETRY_MIN_MS * 2 ** restFailures);
        restFailures += 1;
      } finally {
        restBusy = false;
        if (restAgain && !closed) { restAgain = false; void refresh(); }
      }
    };

    const refreshGate = async () => {
      if (gateBusy) return;
      gateBusy = true;
      try {
        const result = await fetchGateQuotes(tracking());
        if (closed) return;
        take(result);
        if (!hadData) publish();
      } catch {
        // Unreachable: its quotes age out, and the next poll tries again.
      } finally {
        gateBusy = false;
      }
    };

    // Brings the open socket's subscriptions in line with the tracked markets.
    const subscribe = () => {
      const ws = socket;
      if (ws?.readyState !== WebSocket.OPEN) return;
      const wanted = new Set(tracking().filter((a) => a.venue === "hyperliquid").map((a) => a.market));
      for (const coin of wanted) {
        if (subscribed.has(coin)) continue;
        subscribed.add(coin);
        ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin } }));
      }
      for (const coin of subscribed) {
        if (wanted.has(coin)) continue;
        subscribed.delete(coin);
        ws.send(JSON.stringify({ method: "unsubscribe", subscription: { type: "activeAssetCtx", coin } }));
      }
    };

    const reconnect = () => {
      if (closed) return;
      window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(connect, backoff + Math.random() * 500);
      backoff = Math.min(backoff * 2, WS_RETRY_MAX_MS);
    };

    const connect = () => {
      if (closed) return;
      let ws: WebSocket;
      try { ws = new WebSocket(HL_WS_URL); } catch { reconnect(); return; }
      socket = ws;
      // A connection attempt can hang without ever failing; give up on it and try again.
      const opening = window.setTimeout(() => { if (ws.readyState === WebSocket.CONNECTING) ws.close(); }, WS_CONNECT_TIMEOUT_MS);
      ws.onopen = () => {
        window.clearTimeout(opening);
        lastMessageAt = Date.now();
        subscribed = new Set();
        subscribe();
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        let message: { channel?: string; data?: { coin?: unknown; ctx?: unknown } };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.channel !== "activeAssetCtx") return;
        const coin = message.data?.coin;
        const asset = typeof coin === "string" ? trackedRef.current.get(coin) : undefined;
        const quote = asset?.venue === "hyperliquid" ? quoteFromCtx(asset, message.data?.ctx, lastMessageAt) : null;
        if (!asset || !quote) return;
        quotes.set(asset.coin, quote);
        backoff = WS_RETRY_MIN_MS;
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
      ws.onclose = () => {
        window.clearTimeout(opening);
        if (socket === ws) { socket = null; reconnect(); }
      };
    };

    // A newsworthy token has arrived or gone: follow it on the socket, fetch its first quote, forget the ones dropped.
    retrackRef.current = () => {
      for (const coin of quotes.keys()) if (!trackedRef.current.has(coin)) quotes.delete(coin);
      for (const coin of delisted) if (!trackedRef.current.has(coin)) delisted.delete(coin);
      subscribe();
      if (tracking().some((a) => !quotes.has(a.coin))) { void refresh(); void refreshGate(); }
    };

    const socketLive = () => socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < WS_SILENT_MS;

    // Deferred so React's development double-mount does not open and drop a connection.
    const startTimer = window.setTimeout(() => { void refresh(); void refreshGate(); connect(); }, 0);
    const flushTimer = window.setInterval(publish, PRICE_FLUSH_MS);
    const restTimer = window.setInterval(() => {
      const due = socketLive() ? Math.max(nextRestAt, lastRestAt + REST_REFRESH_MS) : nextRestAt;
      if (Date.now() >= due) void refresh();
    }, REST_RETRY_MIN_MS);
    const gateTimer = window.setInterval(() => void refreshGate(), GATE_POLL_MS);
    // Hyperliquid drops idle sockets, so ping; a socket that has gone silent is replaced.
    const pingTimer = window.setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAt > WS_SILENT_MS) socket.close();
      else socket.send(JSON.stringify({ method: "ping" }));
    }, WS_PING_MS);

    return () => {
      closed = true;
      retrackRef.current = null;
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      window.clearInterval(flushTimer);
      window.clearInterval(restTimer);
      window.clearInterval(gateTimer);
      window.clearInterval(pingTimer);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, []);

  const live = view.status === "live";
  const featured = turn.asset;
  const featuredCoin = featured.coin;

  // Next in line. The two lists take turns: SETS_PER_NEWS set tokens, then one newsworthy token, each list
  // carrying on from where it left off, so no market follows itself. A market is passed over while it has no
  // fresh quote or its chart will not load; with no newsworthy token to show, the set tokens simply follow on.
  // The chart of the one chosen loads behind the current one for the whole dwell, so the swap uncovers a
  // finished chart.
  const next = useMemo<{ asset: Asset; story: Story | null } | null>(() => {
    const now = Date.now();
    const usable = (a: Asset) => a.coin !== turn.asset.coin && Boolean(view.quotes[a.coin]) && !(now - failed[a.coin] < CHART_RETRY_MS);
    const set = after(SET_ASSETS, (a) => a.coin, turn.lastSet).find(usable);
    const story = after(stories, (s) => s.asset.coin, turn.lastNews).find((s) => usable(s.asset));
    if (story && (turn.setsSinceNews >= SETS_PER_NEWS || !set)) return { asset: story.asset, story };
    return set ? { asset: set, story: null } : null;
  }, [turn, stories, view.quotes, failed]);
  const nextRef = useRef(next);
  useEffect(() => { nextRef.current = next; }, [next]);
  const nextCoin = next?.asset.coin ?? null;
  const nextReady = nextCoin !== null && ready.includes(nextCoin);
  const featuredBroken = Date.now() - failed[featuredCoin] < CHART_RETRY_MS;
  const dwellMs = turn.story ? newsFeatureMs : featureMs;

  const chartLoaded = useCallback((coin: string, ok: boolean) => {
    if (ok) setReady((r) => (r.includes(coin) ? r : [...r, coin]));
    else setFailed((f) => ({ ...f, [coin]: Date.now() }));
  }, []);

  useEffect(() => {
    if (!live) return;
    setDue(false);
    const timer = window.setTimeout(() => setDue(true), dwellMs);
    return () => window.clearTimeout(timer);
  }, [featuredCoin, live, dwellMs]);

  // The swap waits for the next chart. One that never arrives is dropped, so the rotation moves on to the one after it.
  useEffect(() => {
    if (!live || !nextCoin || nextReady) return;
    const timer = window.setTimeout(() => chartLoaded(nextCoin, false), CHART_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [live, nextCoin, nextReady, chartLoaded]);

  useEffect(() => {
    const chosen = nextRef.current;
    if (!live || !(due || featuredBroken) || !nextCoin || !nextReady || chosen?.asset.coin !== nextCoin) return;
    setTurn((t) => chosen.story
      ? { asset: chosen.asset, story: chosen.story, lastSet: t.lastSet, lastNews: chosen.asset.coin, setsSinceNews: 0 }
      : { asset: chosen.asset, story: null, lastSet: chosen.asset.coin, lastNews: t.lastNews, setsSinceNews: t.setsSinceNews + 1 });
    setReady([]);
  }, [live, due, featuredBroken, nextCoin, nextReady]);

  const nextAsset = next?.asset ?? null;
  const value = useMemo<Markets>(() => ({
    status: view.status,
    assets: tracked.filter((a) => view.quotes[a.coin]),
    quotes: view.quotes,
    featured,
    story: turn.story,
    next: nextAsset,
    chartLoaded,
  }), [view, tracked, featured, turn.story, nextAsset, chartLoaded]);

  return <MarketsContext.Provider value={value}>{children}</MarketsContext.Provider>;
}

/** Scrolling strip of every tracked market: symbol, price, 24-hour change. Fills its container. */
export function TickerTape() {
  const { status, assets, quotes } = useMarkets();
  if (!assets.length) {
    return <div className={styles.tape}><p className={styles.tapeNote}>{status === "loading" ? "Loading markets…" : "Market data unavailable"}</p></div>;
  }
  // Each half must be wider than the strip for the loop to be seamless, so a short list is repeated.
  const repeats = Math.ceil(TAPE_MIN_ITEMS / assets.length);
  const group = Array.from({ length: repeats }, () => assets).flat();
  return (
    <div className={styles.tape}>
      <div className={styles.tapeTrack} style={{ animationDuration: `${group.length * TAPE_SECONDS_PER_ITEM}s` }}>
        {[0, 1].map((half) => (
          <div key={half} className={styles.tapeGroup} aria-hidden={half === 1}>
            {group.map((asset, i) => {
              const quote = quotes[asset.coin];
              return (
                <span key={`${asset.coin}:${i}`} className={styles.tapeItem}>
                  <span className={styles.tapeSymbol}>{asset.symbol}</span>
                  <span>{formatPrice(quote.price)}</span>
                  <span className={quote.changePct < 0 ? styles.down : styles.up}>{formatChange(quote.changePct)}</span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Symbol, name, price and 24-hour change. Sized for the longest case; shrinks to fit if a line ever runs over. */
function Header({ asset, quote }: { asset: Asset; quote: Quote | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const name = useRef<HTMLSpanElement>(null);
  const price = quote ? formatPrice(quote.price) : "--";
  const change = quote ? formatChange(quote.changePct) : "";

  useLayoutEffect(() => {
    const fit = () => {
      if (!box.current || !block.current) return;
      const room = box.current.clientWidth;
      const label = name.current;
      if (label) label.style.fontSize = "";
      let need = block.current.offsetWidth;
      // A long name gives way before the price does: it alone is set smaller, down to half its size.
      if (label && need > room && room > 0) {
        const width = label.offsetWidth;
        const ratio = Math.max(NAME_MIN_SCALE, (width - (need - room)) / width);
        label.style.fontSize = `${Math.floor(parseFloat(getComputedStyle(label).fontSize) * ratio)}px`;
        const after = block.current.offsetWidth;
        if (after < need) need = after; else label.style.fontSize = "";
      }
      // Whatever is still too wide (a very long price) scales the whole block.
      block.current.style.transform = need > room && room > 0 ? `scale(${room / need})` : "";
    };
    fit();
    let cancelled = false;
    document.fonts?.ready.then(() => { if (!cancelled) fit(); }).catch(() => {});
    return () => { cancelled = true; };
  }, [asset.coin, price, change]);

  return (
    <div ref={box} className={`${styles.header} ${styles.swap}`}>
      <div ref={block} className={styles.headerBlock}>
        <span className={styles.symbol}>{asset.symbol}</span>
        <span className={styles.price}>{price}</span>
        <span ref={name} className={styles.name}>{asset.name}</span>
        <span className={styles.change}>
          {quote && <span className={quote.changePct < 0 ? styles.down : styles.up}>{change}</span>}
          {quote && <span className={styles.period}>24h</span>}
        </span>
      </div>
    </div>
  );
}

/** One market at a time: header on top, its candle chart filling the rest. Fills its container. */
export function FeaturedMarket() {
  const { status, quotes, featured, next, chartLoaded } = useMarkets();
  if (status !== "live") {
    return (
      <section className={styles.featured}>
        <div className={styles.header}><p className={styles.headerNote}>{status === "loading" ? "Loading markets…" : "Market data unavailable"}</p></div>
        <div className={styles.chartEmpty} />
      </section>
    );
  }
  return (
    <section className={styles.featured} aria-label={`${featured.name} price`}>
      <Header key={featured.coin} asset={featured} quote={quotes[featured.coin]} />
      <CandleChart featured={featured} next={next} price={quotes[featured.coin]?.price ?? null} onLoaded={chartLoaded} />
    </section>
  );
}
