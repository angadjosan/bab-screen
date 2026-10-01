"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import {
  ASSETS,
  CANDLE_INTERVAL,
  CANDLE_WINDOW_MS,
  HL_WS_URL,
  candleFromRaw,
  fetchCandles,
  fetchQuotes,
  formatChange,
  formatPrice,
  formatScale,
  priceDecimals,
  quoteFromCtx,
  type Asset,
  type Candle,
  type Quote,
} from "@/lib/markets";
import styles from "./Markets.module.css";

/** How long each market stays in the featured slot. A full rotation is this times the number of markets. */
export const FEATURE_MS = 30_000;
/** On-screen prices change at most this often, however fast the feed is. */
export const PRICE_FLUSH_MS = 3_000;
/** Tape speed: one full loop takes this long per listed market (about 150 px/s at 1080p). */
export const TAPE_SECONDS_PER_ITEM = 2.5;

// A quote older than this is not shown; with none left the components fall back to "unavailable".
const STALE_MS = 60_000;
const LOADING_GRACE_MS = 10_000;
// Chart: CANDLE_WINDOW_MS of CANDLE_INTERVAL candles (lib/markets.ts), drawn as bars this wide.
const BAR_MS = 3 * 60_000;
/** The next market's candles are requested this long before it takes the featured slot. */
const PREFETCH_LEAD_MS = 5_000;
/** Fetched candles are reused, not requested again, for this long. */
const CANDLE_TTL_MS = 30_000;
/** The featured chart is kept current by the socket; while the socket is down it is refetched this often instead. */
const CANDLE_REFRESH_MS = 15_000;
const CHART_FONT_PX = 20;
const REST_POLL_MS = 30_000;
const REST_RETRY_MIN_MS = 5_000;
const REST_REFRESH_MS = 5 * 60_000;
const WS_PING_MS = 20_000;
const WS_SILENT_MS = 45_000;
const WS_CONNECT_TIMEOUT_MS = 10_000;
const WS_RETRY_MIN_MS = 1_000;
const WS_RETRY_MAX_MS = 30_000;
const PREFETCH_ATTEMPTS = 3;
const TAPE_MIN_ITEMS = 12;

type Status = "loading" | "live" | "unavailable";
type View = { status: Status; quotes: Record<string, Quote> };
type CandleEntry = { candles: Candle[]; at: number };
type Bar = { open: number; high: number; low: number; close: number; volume: number };
type Markets = {
  status: Status;
  /** Listed markets that currently have a fresh quote, in rotation order. */
  assets: Asset[];
  quotes: Record<string, Quote>;
  featured: Asset;
  candles: Candle[];
  /** When `candles` was last fetched in full; live updates in between do not change it. */
  candlesAt: number;
};

const MarketsContext = createContext<Markets | null>(null);
const BY_COIN = new Map(ASSETS.map((a) => [a.coin, a]));

function useMarkets() {
  const markets = useContext(MarketsContext);
  if (!markets) throw new Error("TickerTape and FeaturedMarket must be rendered inside <MarketsProvider>");
  return markets;
}

/** Fixed window ending now, in BAR_MS bars. A bar the exchange has no candle for stays empty. */
function toBars(candles: Candle[], now: number) {
  const slots = CANDLE_WINDOW_MS / BAR_MS;
  const end = Math.ceil(now / BAR_MS) * BAR_MS;
  const start = end - CANDLE_WINDOW_MS;
  const bars: (Bar | null)[] = Array.from({ length: slots }, () => null);
  for (const c of candles) {
    const i = Math.floor((c.time - start) / BAR_MS);
    if (i < 0 || i >= slots) continue;
    const bar = bars[i];
    if (!bar) bars[i] = { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
    else { bar.high = Math.max(bar.high, c.high); bar.low = Math.min(bar.low, c.low); bar.close = c.close; bar.volume += c.volume; }
  }
  return { bars, start, drawn: bars.reduce((n, b) => n + (b ? 1 : 0), 0) };
}

export function MarketsProvider({ children, featureMs = FEATURE_MS }: { children: ReactNode; featureMs?: number }) {
  const quotesRef = useRef(new Map<string, Quote>());
  const delistedRef = useRef(new Set<string>());
  const candlesRef = useRef(new Map<string, CandleEntry>());
  const inflightRef = useRef(new Map<string, Promise<boolean>>());
  const socketRef = useRef<WebSocket | null>(null);
  /** The coin whose candles should stream over the socket, and the one this socket is actually subscribed to. */
  const followRef = useRef({ wanted: ASSETS[0].coin, subscribed: null as string | null, dirty: false });
  const [view, setView] = useState<View>({ status: "loading", quotes: {} });
  const [featuredCoin, setFeaturedCoin] = useState(ASSETS[0].coin);
  const [, setCandleVersion] = useState(0);
  const [retry, setRetry] = useState(0);

  // Streams live candles for one market at a time, the featured one.
  const follow = useCallback((coin: string) => {
    const state = followRef.current;
    const ws = socketRef.current;
    state.wanted = coin;
    if (ws?.readyState !== WebSocket.OPEN || state.subscribed === coin) return;
    const send = (method: string, target: string) => ws.send(JSON.stringify({ method, subscription: { type: "candle", coin: target, interval: CANDLE_INTERVAL } }));
    if (state.subscribed) send("unsubscribe", state.subscribed);
    send("subscribe", coin);
    state.subscribed = coin;
  }, []);

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
      if (followRef.current.dirty) { followRef.current.dirty = false; setCandleVersion((n) => n + 1); }
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
        socketRef.current = ws;
        followRef.current.subscribed = null;
        follow(followRef.current.wanted);
      };
      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        let message: { channel?: string; data?: { coin?: unknown; ctx?: unknown; s?: unknown } };
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message?.channel === "candle") { liveCandle(message.data); return; }
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
        if (socketRef.current === ws) socketRef.current = null;
        if (socket === ws) { socket = null; reconnect(); }
      };
    };

    // A live candle for the followed market replaces or extends the tail of its fetched history; shown at the next flush.
    const liveCandle = (data: { s?: unknown } | undefined) => {
      const state = followRef.current;
      const asset = typeof data?.s === "string" && data.s === state.wanted ? BY_COIN.get(data.s) : undefined;
      const entry = asset && candlesRef.current.get(asset.coin);
      const candle = asset && candleFromRaw(asset, data);
      if (!entry || !candle) return;
      // Copy before the first change so an array already handed to React is never mutated.
      if (!state.dirty) { entry.candles = entry.candles.slice(); state.dirty = true; }
      const list = entry.candles;
      const i = list.findLastIndex((c) => c.time <= candle.time);
      if (i >= 0 && list[i].time === candle.time) list[i] = candle; else list.splice(i + 1, 0, candle);
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
      socketRef.current = null;
      ws?.close();
    };
  }, [follow]);

  // Resolves false only when the request failed; a thin market can still resolve true with nothing to draw.
  const loadCandles = useCallback((asset: Asset, force = false): Promise<boolean> => {
    const cached = candlesRef.current.get(asset.coin);
    if (!force && cached && Date.now() - cached.at < CANDLE_TTL_MS) return Promise.resolve(true);
    let pending = inflightRef.current.get(asset.coin);
    if (!pending) {
      pending = fetchCandles(asset)
        .then((candles) => { candlesRef.current.set(asset.coin, { candles, at: Date.now() }); setCandleVersion((n) => n + 1); return true; }, () => false)
        .finally(() => inflightRef.current.delete(asset.coin));
      inflightRef.current.set(asset.coin, pending);
    }
    return pending;
  }, []);

  const live = view.status === "live";

  // Rotation: candles are fetched for the featured market and, just before the swap, the one that follows it.
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
      return !!entry && toBars(entry.candles, Date.now()).drawn >= 2;
    };
    const at = Math.max(0, ASSETS.findIndex((a) => a.coin === featuredCoin));
    const current = ASSETS[at];
    const upcoming = ASSETS.slice(at + 1).concat(ASSETS.slice(0, at));

    follow(current.coin);
    void loadCandles(current);
    const refreshTimer = window.setInterval(() => {
      if (socketRef.current?.readyState !== WebSocket.OPEN) void loadCandles(current, true);
    }, CANDLE_REFRESH_MS);

    const findNext = async () => {
      let attempts = 0;
      for (const asset of upcoming) {
        if (cancelled || attempts >= PREFETCH_ATTEMPTS) break;
        if (!quoted(asset)) continue;
        attempts += 1;
        if (!(await loadCandles(asset))) break;
        if (chartable(asset)) return asset;
      }
      return null;
    };
    let next: Promise<Asset | null> | undefined;
    const prefetchTimer = window.setTimeout(() => { next = findNext(); }, Math.max(0, featureMs - PREFETCH_LEAD_MS));
    // A slow prefetch is waited for rather than costing the current market a whole extra turn.
    const swapTimer = window.setTimeout(async () => {
      const asset = await (next ?? findNext());
      if (cancelled) return;
      if (asset) setFeaturedCoin(asset.coin);
      else setRetry((n) => n + 1);
    }, featureMs);
    return () => { cancelled = true; window.clearInterval(refreshTimer); window.clearTimeout(prefetchTimer); window.clearTimeout(swapTimer); };
  }, [featuredCoin, live, retry, featureMs, follow, loadCandles]);

  const featured = BY_COIN.get(featuredCoin) ?? ASSETS[0];
  const entry = candlesRef.current.get(featured.coin);
  const candles = entry?.candles;
  const candlesAt = entry?.at ?? 0;
  const value = useMemo<Markets>(() => ({
    status: view.status,
    assets: ASSETS.filter((a) => view.quotes[a.coin]),
    quotes: view.quotes,
    featured,
    candles: candles ?? [],
    candlesAt,
  }), [view, featured, candles, candlesAt]);

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

type ChartHandle = { chart: IChartApi; price: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram">; up: string; down: string; coin: string; shown: string };

/** Lightweight Charts plots UTC, so times are shifted to read as local time. */
const chartTime = (ms: number) => (ms / 1000 - new Date(ms).getTimezoneOffset() * 60) as UTCTimestamp;
const clockLabel = (time: unknown) => new Date(Number(time) * 1000).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });

/**
 * Candles with volume beneath, drawn by TradingView's Lightweight Charts. One chart instance lives for as long as
 * the component does; changing market swaps its data. Display only: no scrolling, zooming or crosshair.
 */
function Chart({ asset, candles, candlesAt }: { asset: Asset; candles: Candle[]; candlesAt: number }) {
  const host = useRef<HTMLDivElement>(null);
  const handle = useRef<ChartHandle | null>(null);
  const { bars, start, drawn } = toBars(candles, Date.now());

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim();
    const line = color("--mk-line");
    const up = color("--mk-up");
    const down = color("--mk-down");
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: color("--mk-muted"), fontFamily: css.fontFamily, fontSize: CHART_FONT_PX, attributionLogo: true },
      grid: { vertLines: { color: line }, horzLines: { color: line } },
      rightPriceScale: { borderColor: line, scaleMargins: { top: .06, bottom: .27 } },
      timeScale: { borderColor: line, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true, tickMarkFormatter: clockLabel },
      crosshair: { mode: CrosshairMode.Hidden },
      handleScroll: false,
      handleScale: false,
    });
    const price = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceLineColor: color("--mk-faint") });
    // Volume sits in the bottom fifth on its own unlabelled scale, clear of the candles above it.
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: .8, bottom: 0 } });
    // Volume bars take the candle's colour at 40% opacity.
    handle.current = { chart, price, volume, up: `${up}66`, down: `${down}66`, coin: "", shown: "" };
    // Text drawn before the web font arrived is redrawn once it has.
    let disposed = false;
    document.fonts?.ready.then(() => { if (!disposed) chart.applyOptions({ layout: { fontFamily: getComputedStyle(el).fontFamily } }); }).catch(() => {});
    return () => { disposed = true; handle.current = null; chart.remove(); };
  }, []);

  // Runs after every render (prices flush every few seconds), so the window keeps sliding with the clock.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    const time = (i: number) => chartTime(start + i * BAR_MS);
    const candle = (b: Bar, i: number) => ({ time: time(i), open: b.open, high: b.high, low: b.low, close: b.close });
    const volume = (b: Bar, i: number) => ({ time: time(i), value: b.volume, color: b.close >= b.open ? h.up : h.down });
    const shown = `${asset.coin}:${start}:${candlesAt}`;
    if (shown === h.shown) {
      // Same market, same window, same fetch: only the bar in progress can have moved.
      const i = bars.length - 1;
      const bar = bars[i];
      if (bar) { h.price.update(candle(bar, i)); h.volume.update(volume(bar, i)); }
      return;
    }
    if (asset.coin !== h.coin && h.coin && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      host.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
    }
    // The scale reads like the header: the same units, and no finer than the price is quoted.
    const reference = bars.findLast((b) => b)?.close;
    if (reference) {
      h.price.applyOptions({
        priceFormat: {
          type: "custom",
          minMove: asset.unit === "usd-billions" ? .1 : 10 ** -priceDecimals(reference),
          formatter: (value: number) => formatPrice(asset, value),
          tickmarksFormatter: (values: number[]) => formatScale(asset, values),
        },
      });
    }
    // Every slot is sent, empty ones as whitespace, so the time axis always spans the whole window and gaps show as gaps.
    h.price.setData(bars.map((b, i) => (b ? candle(b, i) : { time: time(i) })));
    h.volume.setData(bars.map((b, i) => (b ? volume(b, i) : { time: time(i) })));
    h.chart.timeScale().fitContent();
    h.coin = asset.coin;
    h.shown = shown;
  });

  return (
    <div className={styles.chart} role="img" aria-label={`${asset.name} candlestick chart with volume, last ${CANDLE_WINDOW_MS / 3_600_000} hours`}>
      <div ref={host} className={styles.chartHost} />
      {drawn < 2 && <div className={styles.chartNote}>Waiting for price history…</div>}
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

/** One market at a time: header on top, its candle-and-volume chart filling the rest. Fills its container. */
export function FeaturedMarket() {
  const { status, quotes, featured, candles, candlesAt } = useMarkets();
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
      <Chart asset={featured} candles={candles} candlesAt={candlesAt} />
    </section>
  );
}
