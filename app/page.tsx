"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Candle = { time: number | string; open: number; high: number; low: number; close: number; volume: number };
type BtcResponse = {
  price: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  changePct: number;
  candles: Candle[];
  updatedAt: string;
};
type Tick = Pick<BtcResponse, "price" | "open" | "high" | "low" | "volume" | "changePct" | "updatedAt">;
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

const money = (n: number, digits = 2) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
const LIVE_FEED = "wss://ws-feed.exchange.coinbase.com";
const CANDLE_MS = 60_000;
const timeOf = (v: number | string) => new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
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

function Chart({ candles }: { candles: Candle[] }) {
  const valid = candles.filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
  if (valid.length < 2) return <div className="chart-empty">Waiting for price history…</div>;
  const bucketSize = Math.max(1, Math.ceil(valid.length / 96));
  const plotted = Array.from({ length: Math.ceil(valid.length / bucketSize) }, (_, i) => {
    const bucket = valid.slice(i * bucketSize, (i + 1) * bucketSize);
    return { time: bucket[0].time, open: bucket[0].open, high: Math.max(...bucket.map((c) => c.high)), low: Math.min(...bucket.map((c) => c.low)), close: bucket[bucket.length - 1].close };
  });
  // The viewBox matches the on-screen plot box (about 1156 x 740) so candles are not stretched.
  const width = 1000;
  const height = 640;
  const top = 20;
  const bottom = 20;
  const min = Math.min(...plotted.map((c) => c.low));
  const max = Math.max(...plotted.map((c) => c.high));
  const span = max - min || 1;
  const pad = span * .1;
  const chartMin = min - pad;
  const chartMax = max + pad;
  const y = (value: number) => top + (1 - (value - chartMin) / (chartMax - chartMin)) * (height - top - bottom);
  const cell = width / plotted.length;
  const bodyWidth = Math.max(3, Math.min(9, cell * .68));
  const scale = [0, .25, .5, .75, 1].map((p) => chartMax - p * (chartMax - chartMin));
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label="Bitcoin candlestick price chart" className="chart-svg">
        {scale.map((value) => <line key={value} x1="0" x2={width} y1={y(value)} y2={y(value)} className="chart-grid" />)}
        {plotted.map((c, i) => {
          const x = (i + .5) * cell;
          const bodyTop = Math.min(y(c.open), y(c.close));
          const bodyHeight = Math.max(2, Math.abs(y(c.open) - y(c.close)));
          return <g key={i} className={c.close >= c.open ? "candle-up" : "candle-down"}><line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} strokeWidth="1.4" /><rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} /></g>;
        })}
      </svg>
      <div className="chart-y-labels">{scale.map((value) => <span key={value} style={{ top: `${(y(value) / height) * 100}%` }}>{money(value, 0)}</span>)}</div>
      <div className="chart-x-labels">
        {[0, .25, .5, .75, 1].map((p) => {
          const candle = candles[Math.min(candles.length - 1, Math.round((candles.length - 1) * p))];
          return <span key={p}>{candle ? timeOf(candle.time).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}</span>;
        })}
      </div>
    </div>
  );
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
  const [btc, setBtc] = useState<BtcResponse | null>(null);
  const [spot, setSpot] = useState<SpotResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState<Tick | null>(null);
  const pendingTick = useRef<Tick | null>(null);

  const refresh = useCallback(async () => {
    const [btcResult, spotResult] = await Promise.allSettled([
      fetch("/api/btc", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("BTC request failed"); return r.json() as Promise<BtcResponse>; }),
      fetch("/api/spot", { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error("Spot request failed"); return r.json() as Promise<SpotResponse>; }),
    ]);
    if (btcResult.status === "fulfilled") setBtc(btcResult.value);
    if (spotResult.status === "fulfilled") setSpot(spotResult.value);
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

  // Coinbase pushes a ticker on every trade; /api/btc stays as the source for candles and as the fallback when the socket is down.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: number | undefined;
    let flush: number | undefined;
    let closed = false;
    const connect = () => {
      socket = new WebSocket(LIVE_FEED);
      socket.onopen = () => socket?.send(JSON.stringify({ type: "subscribe", product_ids: ["BTC-USD"], channels: ["ticker"] }));
      socket.onmessage = (event) => {
        let message: Record<string, string>;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type !== "ticker") return;
        const price = Number(message.price);
        const open = Number(message.open_24h);
        if (!(price > 0) || !(open > 0)) return;
        pendingTick.current = { price, open, high: Number(message.high_24h), low: Number(message.low_24h), volume: Number(message.volume_24h) * price, changePct: ((price - open) / open) * 100, updatedAt: message.time ?? new Date().toISOString() };
        flush ??= window.setTimeout(() => { flush = undefined; setTick(pendingTick.current); }, 3_000);
      };
      socket.onclose = () => {
        setTick(null);
        if (!closed) retry = window.setTimeout(connect, 2_000);
      };
      socket.onerror = () => socket?.close();
    };
    connect();
    return () => { closed = true; window.clearTimeout(retry); window.clearTimeout(flush); socket?.close(); };
  }, []);

  const market = useMemo(() => {
    if (!btc || !tick) return btc;
    const last = btc.candles.at(-1);
    const lastTime = last ? timeOf(last.time).getTime() : 0;
    const live = last && Date.parse(tick.updatedAt) < lastTime + CANDLE_MS;
    const candles = live ? [...btc.candles.slice(0, -1), { ...last, close: tick.price, high: Math.max(last.high, tick.price), low: Math.min(last.low, tick.price) }] : btc.candles;
    return { ...btc, ...tick, candles };
  }, [btc, tick]);

  return (
    <main className="dashboard">
      <div className={`price ${market ? "" : "price-pending"}`} aria-label="Bitcoin price in US dollars">{market ? money(market.price) : loading ? "$--,---.--" : "Price unavailable"}</div>
      <Chart candles={market?.candles ?? []} />
      <SpotCard spot={spot} loading={loading} />
    </main>
  );
}
