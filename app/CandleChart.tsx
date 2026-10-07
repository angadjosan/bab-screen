"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { CANDLE_COUNT, fetchCandles, type Candle } from "@/lib/candles";
import { PRICE_GUTTER_PX, chartGeometry, type Box, type ChartGeometry } from "@/lib/chart-geometry";
import { formatPrice, type Asset } from "@/lib/markets";
import styles from "./CandleChart.module.css";

const REFRESH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** A price level's label is left out when the live price's tag would sit on top of it. */
const LABEL_CLEARANCE_PX = 40;
const LIVE_TAG_HEIGHT = 40;
const timeLabel = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true });

type CandleStore = Record<string, Candle[]>;

async function loadCandles(asset: Asset): Promise<Candle[] | null> {
  const request = new AbortController();
  const giveUp = window.setTimeout(() => request.abort(), REQUEST_TIMEOUT_MS);
  try {
    const candles = await fetchCandles(asset, request.signal);
    return candles.length > 1 ? candles : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(giveUp);
  }
}

/**
 * Candles for the featured market, refreshed every minute, and for the next one, fetched ahead so the swap shows a
 * finished chart. `onLoaded` tells the rotation whether a market's chart could be drawn (MarketsProvider).
 */
function useCandles(featured: Asset, next: Asset | null, onLoaded: (coin: string, ok: boolean) => void) {
  const [store, setStore] = useState<CandleStore>({});
  const wanted = [featured, ...(next && next.coin !== featured.coin ? [next] : [])];
  const wantedKey = wanted.map((asset) => asset.coin).join(",");
  const assets = useRef(wanted);
  assets.current = wanted;

  useEffect(() => {
    let alive = true;
    const refresh = () => assets.current.forEach(async (asset) => {
      const candles = await loadCandles(asset);
      if (!alive) return;
      if (candles) setStore((current) => ({ ...current, [asset.coin]: candles }));
      onLoaded(asset.coin, candles !== null);
    });
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [wantedKey, onLoaded]);

  return store[featured.coin] ?? null;
}

function useBox() {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, box };
}

function Grid({ geometry, liveY }: { geometry: ChartGeometry; liveY: number | null }) {
  return (
    <g>
      {geometry.levels.map((level) => (
        <g key={level.price}>
          <line x1={0} x2={geometry.plot.width} y1={level.y} y2={level.y} className={styles.rule} />
          {(liveY === null || Math.abs(level.y - liveY) > LABEL_CLEARANCE_PX) && (
            <text x={geometry.plot.width + 18} y={level.y} dominantBaseline="middle" className={styles.label}>{formatPrice(level.price)}</text>
          )}
        </g>
      ))}
      {geometry.ticks.map((tick) => (
        <text key={tick.at} x={tick.x} y={geometry.plot.height + 30} textAnchor="middle" className={styles.label}>{timeLabel.format(tick.at)}</text>
      ))}
    </g>
  );
}

/** Each candle grows up from the floor as it arrives, the first of them a beat before the last. */
function Candles({ geometry }: { geometry: ChartGeometry }) {
  return (
    <g>
      {geometry.candles.map((mark, index) => (
        <g key={mark.key} className={`${styles.candle} ${mark.rising ? styles.rising : styles.falling}`} style={{ animationDelay: `${index * 14}ms` } as CSSProperties}>
          <rect x={mark.x} y={geometry.plot.height - mark.volumeHeight} width={mark.width} height={mark.volumeHeight} className={styles.volume} />
          <line x1={mark.x + mark.width / 2} x2={mark.x + mark.width / 2} y1={mark.wickTop} y2={mark.wickBottom} className={styles.wick} />
          <rect x={mark.x} y={mark.bodyTop} width={mark.width} height={mark.bodyHeight} className={styles.body} />
        </g>
      ))}
    </g>
  );
}

/** The price now: a gold dotted line across the plot and a white tag in the price column, easing to each new price. */
function LivePrice({ geometry, price }: { geometry: ChartGeometry; price: number }) {
  return (
    <g className={styles.live} style={{ transform: `translateY(${geometry.priceY(price)}px)` }}>
      <line x1={0} x2={geometry.plot.width} y1={0} y2={0} className={styles.liveLine} />
      <rect x={geometry.plot.width + 6} y={-LIVE_TAG_HEIGHT / 2} width={PRICE_GUTTER_PX - 6} height={LIVE_TAG_HEIGHT} className={styles.liveTag} />
      <text x={geometry.plot.width + 18} y={1} dominantBaseline="middle" className={styles.liveText}>{formatPrice(price)}</text>
    </g>
  );
}

/**
 * The featured market's last 24 hours in half-hour candles, with volume under them, drawn on the page's own palette.
 * Always 24 hours whatever its width, so it reads the same in the middle column and across focus mode.
 */
export function CandleChart({ featured, next, price, onLoaded }: { featured: Asset; next: Asset | null; price: number | null; onLoaded: (coin: string, ok: boolean) => void }) {
  const candles = useCandles(featured, next, onLoaded);
  const { ref, box } = useBox();
  const geometry = candles && box.width > 0 ? chartGeometry(candles, box, price, CANDLE_COUNT) : null;
  return (
    <div ref={ref} className={styles.chart}>
      {!candles && <p className={styles.note}>Loading chart…</p>}
      {geometry && (
        <svg key={featured.coin} width={box.width} height={box.height} className={styles.svg} role="img" aria-label={`${featured.name} price over the last 24 hours, in half-hour candles`}>
          <Grid geometry={geometry} liveY={price === null ? null : geometry.priceY(price)} />
          <Candles geometry={geometry} />
          {price !== null && <LivePrice geometry={geometry} price={price} />}
        </svg>
      )}
    </div>
  );
}
