"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ASSETS, HL_WS_URL, TV_WIDGET_ORIGIN, chartUrl, fetchQuotes, formatChange, formatPrice, quoteFromCtx, type Asset, type Quote } from "@/lib/markets";
import styles from "./Markets.module.css";

/** How long each market stays in the featured slot. A full rotation is this times the number of charted markets. */
export const FEATURE_MS = 10_000;
/** On-screen prices change at most this often, however fast the feed is. */
export const PRICE_FLUSH_MS = 3_000;
/** Tape speed: one full loop takes this long per listed market (about 150 px/s at 1080p). */
export const TAPE_SECONDS_PER_ITEM = 2.5;

// A quote older than this is not shown; with none left the components fall back to "unavailable".
const STALE_MS = 60_000;
const LOADING_GRACE_MS = 10_000;
// The chart widget says when its page has loaded but not when it has drawn; drawing takes about a second more.
const CHART_SETTLE_MS = 3_000;
/** A chart that has not loaded after this long is given up on, and its market left out of the rotation ... */
const CHART_TIMEOUT_MS = 30_000;
/** ... until this much later. */
const CHART_RETRY_MS = 10 * 60_000;
const REST_POLL_MS = 30_000;
const REST_RETRY_MIN_MS = 5_000;
const REST_REFRESH_MS = 5 * 60_000;
const WS_PING_MS = 20_000;
const WS_SILENT_MS = 45_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_RETRY_MIN_MS = 1_000;
const WS_RETRY_MAX_MS = 30_000;
const TAPE_MIN_ITEMS = 12;

type Status = "loading" | "live" | "unavailable";
type View = { status: Status; quotes: Record<string, Quote> };
type Markets = {
  status: Status;
  /** Listed markets that currently have a fresh quote, in tape order. */
  assets: Asset[];
  quotes: Record<string, Quote>;
  featured: Asset;
  /** The market that takes the featured slot next; its chart loads out of sight meanwhile. */
  next: Asset | null;
  /** Called by the chart: `ok` once a market's chart is ready to show, otherwise it could not be loaded. */
  chartLoaded: (coin: string, ok: boolean) => void;
};

const MarketsContext = createContext<Markets | null>(null);
const BY_COIN = new Map(ASSETS.map((a) => [a.coin, a]));
/** Markets that can take the featured slot, in rotation order: the ones TradingView has a chart for. */
const CHARTED = ASSETS.filter((a) => a.tv);

function useMarkets() {
  const markets = useContext(MarketsContext);
  if (!markets) throw new Error("TickerTape and FeaturedMarket must be rendered inside <MarketsProvider>");
  return markets;
}

export function MarketsProvider({ children, featureMs = FEATURE_MS }: { children: ReactNode; featureMs?: number }) {
  const quotesRef = useRef(new Map<string, Quote>());
  const delistedRef = useRef(new Set<string>());
  const [view, setView] = useState<View>({ status: "loading", quotes: {} });
  const [featuredCoin, setFeaturedCoin] = useState(CHARTED[0].coin);
  /** The dwell is over: swap as soon as the next chart is ready. */
  const [due, setDue] = useState(false);
  /** Markets whose chart has loaded since the last swap. */
  const [ready, setReady] = useState<readonly string[]>([]);
  /** Markets whose chart would not load, and when. */
  const [failed, setFailed] = useState<Record<string, number>>({});

  // One WebSocket carries every price. REST seeds the first paint, fills in while the socket is down, and catches delistings.
  useEffect(() => {
    const quotes = quotesRef.current;
    const delisted = delistedRef.current;
    const startedAt = Date.now();
    let closed = false;
    let hadData = false;
    let socket: WebSocket | null = null;
    let backoff = WS_RETRY_MIN_MS;
    let lastMessageAt = 0;
    let lastRestAt = 0;
    let nextRestAt = 0;
    let restFailures = 0;
    let restBusy = false;
    let retryTimer: number | undefined;

    const publish = () => {
      const now = Date.now();
      const fresh: Record<string, Quote> = {};
      for (const [coin, quote] of quotes) if (now - quote.at < STALE_MS && !delisted.has(coin)) fresh[coin] = quote;
      const any = Object.keys(fresh).length > 0;
      if (any) hadData = true;
      setView({ status: any ? "live" : hadData || now - startedAt > LOADING_GRACE_MS ? "unavailable" : "loading", quotes: fresh });
    };

    const refresh = async () => {
      if (restBusy) return;
      restBusy = true;
      try {
        const result = await fetchQuotes();
        if (closed) return;
        for (const [coin, quote] of result.quotes) {
          delisted.delete(coin);
          const current = quotes.get(coin);
          if (!current || current.at < quote.at) quotes.set(coin, quote);
        }
        for (const coin of result.delisted) { delisted.add(coin); quotes.delete(coin); }
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
        for (const asset of ASSETS) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: asset.coin } }));
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        let message: { channel?: string; data?: { coin?: unknown; ctx?: unknown } };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.channel !== "activeAssetCtx") return;
        const coin = message.data?.coin;
        const asset = typeof coin === "string" ? BY_COIN.get(coin) : undefined;
        const quote = asset && quoteFromCtx(asset, message.data?.ctx, lastMessageAt);
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

    const socketLive = () => socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < WS_SILENT_MS;

    // Deferred so React's development double-mount does not open and drop a connection.
    const startTimer = window.setTimeout(() => { void refresh(); connect(); }, 0);
    const flushTimer = window.setInterval(publish, PRICE_FLUSH_MS);
    const restTimer = window.setInterval(() => {
      const due = socketLive() ? Math.max(nextRestAt, lastRestAt + REST_REFRESH_MS) : nextRestAt;
      if (Date.now() >= due) void refresh();
    }, REST_RETRY_MIN_MS);
    // Hyperliquid drops idle sockets, so ping; a socket that has gone silent is replaced.
    const pingTimer = window.setInterval(() => {
      if (socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastMessageAt > WS_SILENT_MS) socket.close();
      else socket.send(JSON.stringify({ method: "ping" }));
    }, WS_PING_MS);

    return () => {
      closed = true;
      window.clearTimeout(startTimer);
      window.clearTimeout(retryTimer);
      window.clearInterval(flushTimer);
      window.clearInterval(restTimer);
      window.clearInterval(pingTimer);
      const ws = socket;
      socket = null;
      ws?.close();
    };
  }, []);

  const live = view.status === "live";
  const featured = BY_COIN.get(featuredCoin) ?? CHARTED[0];

  // Next in line: the first charted market after the featured one that has a fresh quote and a chart that loads.
  // Its chart loads behind the current one for the whole dwell, so the swap uncovers a finished chart.
  const at = CHARTED.indexOf(featured);
  const now = Date.now();
  const broken = (coin: string) => now - failed[coin] < CHART_RETRY_MS;
  const next = CHARTED.slice(at + 1).concat(CHARTED.slice(0, at)).find((a) => view.quotes[a.coin] && !broken(a.coin)) ?? null;
  const nextCoin = next?.coin ?? null;
  const nextReady = nextCoin !== null && ready.includes(nextCoin);
  const featuredBroken = broken(featuredCoin);

  const chartLoaded = useCallback((coin: string, ok: boolean) => {
    if (ok) setReady((r) => (r.includes(coin) ? r : [...r, coin]));
    else setFailed((f) => ({ ...f, [coin]: Date.now() }));
  }, []);

  useEffect(() => {
    if (!live) return;
    setDue(false);
    const timer = window.setTimeout(() => setDue(true), featureMs);
    return () => window.clearTimeout(timer);
  }, [featuredCoin, live, featureMs]);

  // The swap waits for the next chart. One that never arrives is dropped, so the rotation moves on to the one after it.
  useEffect(() => {
    if (!live || !nextCoin || nextReady) return;
    const timer = window.setTimeout(() => chartLoaded(nextCoin, false), CHART_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [live, nextCoin, nextReady, chartLoaded]);

  useEffect(() => {
    if (!live || !(due || featuredBroken) || !nextCoin || !nextReady) return;
    setFeaturedCoin(nextCoin);
    setReady([]);
  }, [live, due, featuredBroken, nextCoin, nextReady]);

  const value = useMemo<Markets>(() => ({
    status: view.status,
    assets: ASSETS.filter((a) => view.quotes[a.coin]),
    quotes: view.quotes,
    featured,
    next,
    chartLoaded,
  }), [view, featured, next, chartLoaded]);

  return <MarketsContext.Provider value={value}>{children}</MarketsContext.Provider>;
}

/** Scrolling strip of every listed market: symbol, price, 24-hour change. Fills its container. */
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
                  <span>{formatPrice(asset, quote.price)}</span>
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

/**
 * TradingView's Advanced Chart widget for the featured market: candles with volume, from TradingView's own
 * Hyperliquid feed. The next market's chart loads underneath the current one and is uncovered at the swap,
 * so a chart is never seen loading. The outgoing frame is removed, so only two exist at a time.
 */
function Chart({ featured, next, onLoaded }: { featured: Asset; next: Asset | null; onLoaded: (coin: string, ok: boolean) => void }) {
  const frames = useRef(new Map<string, HTMLIFrameElement>());

  useEffect(() => {
    const timers = new Set<number>();
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== TV_WIDGET_ORIGIN) return;
      const coin = [...frames.current].find(([, frame]) => frame.contentWindow === event.source)?.[0];
      if (!coin) return;
      let name: unknown;
      try { name = (typeof event.data === "string" ? JSON.parse(event.data) : event.data)?.name; } catch { return; }
      if (name === "tv-widget-no-data") onLoaded(coin, false);
      if (name !== "tv-widget-load") return;
      const timer = window.setTimeout(() => {
        timers.delete(timer);
        if (frames.current.has(coin)) onLoaded(coin, true);
      }, CHART_SETTLE_MS);
      timers.add(timer);
    };
    window.addEventListener("message", onMessage);
    return () => { window.removeEventListener("message", onMessage); timers.forEach((timer) => window.clearTimeout(timer)); };
  }, [onLoaded]);

  // Featured first, next second: React leaves the next market's frame in place when it becomes the featured one.
  const shown = next && next.coin !== featured.coin ? [featured, next] : [featured];
  return (
    <div className={styles.chart}>
      <div className={styles.chartFrames}>
        {shown.map((asset) => asset.tv && (
          <iframe
            key={asset.coin}
            ref={(frame) => { if (frame) frames.current.set(asset.coin, frame); else frames.current.delete(asset.coin); }}
            className={asset === featured ? `${styles.chartFrame} ${styles.chartFront}` : styles.chartFrame}
            src={chartUrl(asset.tv)}
            title={`${asset.name} candlestick chart with volume, by TradingView`}
            aria-hidden={asset !== featured}
            tabIndex={-1}
          />
        ))}
      </div>
      <p className={styles.chartCredit}>
        <span>{featured.lot > 1 && `Chart is priced per ${featured.lot.toLocaleString("en-US")} ${featured.symbol}`}</span>
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener nofollow">Track all markets on TradingView</a>
      </p>
    </div>
  );
}

/** Symbol, name, price and 24-hour change. Sized for the longest case; shrinks to fit if a line ever runs over. */
function Header({ asset, quote }: { asset: Asset; quote: Quote | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  const block = useRef<HTMLDivElement>(null);
  const price = quote ? formatPrice(asset, quote.price) : "--";
  const change = quote ? formatChange(quote.changePct) : "";

  useLayoutEffect(() => {
    const fit = () => {
      if (!box.current || !block.current) return;
      const room = box.current.clientWidth;
      const need = block.current.offsetWidth;
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
        <span className={styles.name}>{asset.name}</span>
        <span className={styles.change}>
          {quote && <span className={quote.changePct < 0 ? styles.down : styles.up}>{change}</span>}
          {quote && <span className={styles.period}>24h</span>}
        </span>
      </div>
    </div>
  );
}

/** One market at a time: header on top, its TradingView chart filling the rest. Fills its container. */
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
      <Chart featured={featured} next={next} onLoaded={chartLoaded} />
    </section>
  );
}
