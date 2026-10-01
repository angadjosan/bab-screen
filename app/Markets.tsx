"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ASSETS,
  CANDLE_WINDOW_MS,
  HL_WS_URL,
  fetchCandles,
  fetchQuotes,
  formatChange,
  formatPrice,
  quoteFromCtx,
  scaleDecimals,
  type Asset,
  type Candle,
  type Quote,
} from "@/lib/markets";
import styles from "./Markets.module.css";

/** How long each market stays in the featured slot. */
export const FEATURE_MS = 12_000;
/** On-screen prices change at most this often, however fast the feed is. */
export const PRICE_FLUSH_MS = 3_000;
/** Tape speed: one full loop takes this long per listed market (about 150 px/s at 1080p). */
export const TAPE_SECONDS_PER_ITEM = 2.5;

// A quote older than this is not shown; with none left the components fall back to "unavailable".
const STALE_MS = 60_000;
const LOADING_GRACE_MS = 10_000;
const CANDLE_TTL_MS = 30_000;
const BAR_MS = 3 * 60_000;
const REST_POLL_MS = 30_000;
const REST_REFRESH_MS = 5 * 60_000;
const WS_PING_MS = 20_000;
const WS_SILENT_MS = 45_000;
const WS_RETRY_MIN_MS = 1_000;
const WS_RETRY_MAX_MS = 30_000;
const PREFETCH_ATTEMPTS = 3;
const TAPE_MIN_ITEMS = 12;

type Status = "loading" | "live" | "unavailable";
type View = { status: Status; quotes: Record<string, Quote> };
type CandleEntry = { candles: Candle[]; at: number };
type Bar = { open: number; high: number; low: number; close: number };
type Markets = {
  status: Status;
  /** Listed markets that currently have a fresh quote, in rotation order. */
  assets: Asset[];
  quotes: Record<string, Quote>;
  featured: Asset;
  candles: Candle[];
};

const MarketsContext = createContext<Markets | null>(null);
const WANTED = new Set(ASSETS.map((a) => a.coin));

function useMarkets() {
  const markets = useContext(MarketsContext);
  if (!markets) throw new Error("TickerTape and FeaturedMarket must be rendered inside <MarketsProvider>");
  return markets;
}

/** Fixed four-hour window ending now, in three-minute bars. A bar with no trades stays empty. */
function toBars(candles: Candle[], now: number) {
  const slots = CANDLE_WINDOW_MS / BAR_MS;
  const end = Math.ceil(now / BAR_MS) * BAR_MS;
  const start = end - CANDLE_WINDOW_MS;
  const bars: (Bar | null)[] = Array.from({ length: slots }, () => null);
  for (const c of candles) {
    const i = Math.floor((c.time - start) / BAR_MS);
    if (i < 0 || i >= slots) continue;
    const bar = bars[i];
    if (!bar) bars[i] = { open: c.open, high: c.high, low: c.low, close: c.close };
    else { bar.high = Math.max(bar.high, c.high); bar.low = Math.min(bar.low, c.low); bar.close = c.close; }
  }
  return { bars, start, drawn: bars.reduce((n, b) => n + (b ? 1 : 0), 0) };
}

export function MarketsProvider({ children, featureMs = FEATURE_MS }: { children: ReactNode; featureMs?: number }) {
  const quotesRef = useRef(new Map<string, Quote>());
  const delistedRef = useRef(new Set<string>());
  const candlesRef = useRef(new Map<string, CandleEntry>());
  const inflightRef = useRef(new Map<string, Promise<boolean>>());
  const [view, setView] = useState<View>({ status: "loading", quotes: {} });
  const [featuredCoin, setFeaturedCoin] = useState(ASSETS[0].coin);
  const [, setCandleVersion] = useState(0);
  const [retry, setRetry] = useState(0);

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
        if (!hadData) publish();
      } catch {
        // Unreachable: quotes age out and the next poll tries again.
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
      ws.onopen = () => {
        lastMessageAt = Date.now();
        for (const asset of ASSETS) ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: asset.coin } }));
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        let message: { channel?: string; data?: { coin?: unknown; ctx?: unknown } };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.channel !== "activeAssetCtx") return;
        const coin = message.data?.coin;
        if (typeof coin !== "string" || !WANTED.has(coin)) return;
        const quote = quoteFromCtx(message.data?.ctx, lastMessageAt);
        if (!quote) return;
        quotes.set(coin, quote);
        backoff = WS_RETRY_MIN_MS;
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
      ws.onclose = () => { if (socket === ws) { socket = null; reconnect(); } };
    };

    const socketLive = () => socket?.readyState === WebSocket.OPEN && Date.now() - lastMessageAt < WS_SILENT_MS;

    // Deferred so React's development double-mount does not open and drop a connection.
    const startTimer = window.setTimeout(() => { void refresh(); connect(); }, 0);
    const flushTimer = window.setInterval(publish, PRICE_FLUSH_MS);
    const restTimer = window.setInterval(() => {
      if (!socketLive() || Date.now() - lastRestAt > REST_REFRESH_MS) void refresh();
    }, REST_POLL_MS);
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

  // Resolves false only when the request failed; a thin market can still resolve true with nothing to draw.
  const loadCandles = useCallback((coin: string): Promise<boolean> => {
    const cached = candlesRef.current.get(coin);
    if (cached && Date.now() - cached.at < CANDLE_TTL_MS) return Promise.resolve(true);
    let pending = inflightRef.current.get(coin);
    if (!pending) {
      pending = fetchCandles(coin)
        .then((candles) => { candlesRef.current.set(coin, { candles, at: Date.now() }); setCandleVersion((n) => n + 1); return true; }, () => false)
        .finally(() => inflightRef.current.delete(coin));
      inflightRef.current.set(coin, pending);
    }
    return pending;
  }, []);

  const live = view.status === "live";

  // Rotation: candles are fetched only for the featured market and, ahead of time, the one after it.
  // A market with no fresh quote or nothing to chart is skipped.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const quoted = (asset: Asset) => {
      const quote = quotesRef.current.get(asset.coin);
      return !!quote && Date.now() - quote.at < STALE_MS && !delistedRef.current.has(asset.coin);
    };
    const chartable = (asset: Asset) => {
      const entry = candlesRef.current.get(asset.coin);
      return !!entry && Date.now() - entry.at < featureMs + 2 * CANDLE_TTL_MS && toBars(entry.candles, Date.now()).drawn >= 2;
    };
    const at = Math.max(0, ASSETS.findIndex((a) => a.coin === featuredCoin));
    const upcoming = ASSETS.slice(at + 1).concat(ASSETS.slice(0, at));

    void loadCandles(featuredCoin);
    void (async () => {
      let attempts = 0;
      for (const asset of upcoming) {
        if (cancelled || attempts >= PREFETCH_ATTEMPTS) return;
        if (!quoted(asset)) continue;
        attempts += 1;
        if (!(await loadCandles(asset.coin)) || chartable(asset)) return;
      }
    })();

    const timer = window.setTimeout(() => {
      const next = upcoming.find((asset) => quoted(asset) && chartable(asset));
      if (next) setFeaturedCoin(next.coin);
      else setRetry((n) => n + 1);
    }, featureMs);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [featuredCoin, live, retry, featureMs, loadCandles]);

  const featured = ASSETS.find((a) => a.coin === featuredCoin) ?? ASSETS[0];
  const candles = candlesRef.current.get(featured.coin)?.candles;
  const value = useMemo<Markets>(() => ({
    status: view.status,
    assets: ASSETS.filter((a) => view.quotes[a.coin]),
    quotes: view.quotes,
    featured,
    candles: candles ?? [],
  }), [view, featured, candles]);

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

function Chart({ asset, candles }: { asset: Asset; candles: Candle[] }) {
  const { bars, start, drawn } = toBars(candles, Date.now());
  if (drawn < 2) return <div className={styles.chartEmpty}>Waiting for price history…</div>;
  // The viewBox is close to the on-screen plot box so candles are not stretched.
  const width = 1000;
  const height = 640;
  const top = 20;
  const bottom = 20;
  const plotted = bars.filter((b): b is Bar => b !== null);
  const min = Math.min(...plotted.map((b) => b.low));
  const max = Math.max(...plotted.map((b) => b.high));
  const span = max - min || max * .001 || 1;
  const pad = span * .1;
  const chartMin = min - pad;
  const chartMax = max + pad;
  const y = (value: number) => top + (1 - (value - chartMin) / (chartMax - chartMin)) * (height - top - bottom);
  const cell = width / bars.length;
  const bodyWidth = Math.max(3, Math.min(9, cell * .68));
  const scale = [0, .25, .5, .75, 1].map((p) => chartMax - p * (chartMax - chartMin));
  const decimals = scaleDecimals(asset, (chartMax - chartMin) / 4, chartMax);
  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${asset.name} candlestick chart, last four hours`} className={styles.chartSvg}>
        {scale.map((value, i) => <line key={i} x1="0" x2={width} y1={y(value)} y2={y(value)} className={styles.chartGrid} />)}
        {bars.map((b, i) => {
          if (!b) return null;
          const x = (i + .5) * cell;
          const bodyTop = Math.min(y(b.open), y(b.close));
          const bodyHeight = Math.max(2, Math.abs(y(b.open) - y(b.close)));
          return <g key={i} className={b.close >= b.open ? styles.candleUp : styles.candleDown}><line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} strokeWidth="1.4" /><rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} /></g>;
        })}
      </svg>
      <div className={styles.chartYLabels}>{scale.map((value, i) => <span key={i} style={{ top: `${(y(value) / height) * 100}%` }}>{formatPrice(asset, value, decimals)}</span>)}</div>
      <div className={styles.chartXLabels}>
        {[0, .25, .5, .75, 1].map((p) => <span key={p}>{new Date(start + p * CANDLE_WINDOW_MS).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</span>)}
      </div>
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
    <div ref={box} className={styles.header}>
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

/** One market at a time: header on top, its candle chart filling the rest. Fills its container. */
export function FeaturedMarket() {
  const { status, quotes, featured, candles } = useMarkets();
  if (status !== "live") {
    return (
      <section className={styles.featured}>
        <div className={styles.header}><p className={styles.headerNote}>{status === "loading" ? "Loading markets…" : "Market data unavailable"}</p></div>
        <div className={styles.chartEmpty} />
      </section>
    );
  }
  return (
    <section key={featured.coin} className={`${styles.featured} ${styles.swap}`} aria-label={`${featured.name} price`}>
      <Header asset={featured} quote={quotes[featured.coin]} />
      <Chart asset={featured} candles={candles} />
    </section>
  );
}
