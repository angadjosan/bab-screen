import { NextResponse } from "next/server";

export const runtime = "nodejs";

const BASE = "https://api.exchange.coinbase.com/products/BTC-USD";

type Ticker = { price?: string; time?: string; volume?: string };
type Stats = { open?: string; high?: string; low?: string; volume?: string };
type RawCandle = [number, number, number, number, number, number];

async function getJson<T>(path: string, revalidate: number): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Accept: "application/json", "User-Agent": "spot-screen/0.1" },
    next: { revalidate },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Coinbase returned ${response.status}`);
  return (await response.json()) as T;
}

export async function GET() {
  try {
    const now = Date.now();
    const start = new Date(now - 4 * 60 * 60 * 1000).toISOString();
    const end = new Date(now).toISOString();
    const [ticker, stats, rawCandles] = await Promise.all([
      getJson<Ticker>("/ticker", 10),
      getJson<Stats>("/stats", 30),
      getJson<RawCandle[]>(`/candles?granularity=60&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`, 30),
    ]);

    const price = Number(ticker.price);
    const open = Number(stats.open);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(open) || open <= 0 || !Array.isArray(rawCandles)) {
      throw new Error("Invalid market data");
    }

    const candles = rawCandles
      .filter((row): row is RawCandle => Array.isArray(row) && row.length >= 6 && row.every((value) => Number.isFinite(value)))
      .map(([time, low, high, candleOpen, close, volume]) => ({
        time: time * 1000,
        open: candleOpen,
        high,
        low,
        close,
        volume,
      }))
      .sort((a, b) => a.time - b.time);

    return NextResponse.json(
      {
        price,
        open,
        high: Number(stats.high),
        low: Number(stats.low),
        volume: Number(stats.volume ?? ticker.volume) * price,
        changePct: ((price - open) / open) * 100,
        candles,
        updatedAt: ticker.time ?? new Date().toISOString(),
        source: "Coinbase Exchange BTC-USD",
      },
      { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } },
    );
  } catch (error) {
    console.error("BTC market data error", error);
    return NextResponse.json({ error: "BTC market data is unavailable. Please retry shortly." }, { status: 503 });
  }
}
