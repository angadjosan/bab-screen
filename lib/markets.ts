// Market definitions and Hyperliquid helpers shared by app/Markets.tsx.
// Everything comes from Hyperliquid's public API (no key): the main perp dex for crypto,
// trade.xyz's HIP-3 dex ("xyz") for the S&P 500 and stocks, EntropyIO's ("io") for the pre-IPO markets.

export type AssetKind = "crypto" | "index" | "stock" | "preipo";

export type Asset = {
  /** Symbol shown on screen. */
  symbol: string;
  name: string;
  /** Hyperliquid coin id. HIP-3 markets are prefixed with their dex, e.g. "xyz:NVDA". */
  coin: string;
  kind: AssetKind;
  /** "usd-billions": the contract is quoted in billions of dollars of implied company valuation. */
  unit: "usd" | "usd-billions";
};

const crypto = (symbol: string, name: string): Asset => ({ symbol, name, coin: symbol, kind: "crypto", unit: "usd" });
const stock = (symbol: string, name: string): Asset => ({ symbol, name, coin: `xyz:${symbol}`, kind: "stock", unit: "usd" });

// Order is the rotation order and the tape order.
export const ASSETS: readonly Asset[] = [
  crypto("BTC", "Bitcoin"),
  crypto("ETH", "Ethereum"),
  crypto("SOL", "Solana"),
  crypto("HYPE", "Hyperliquid"),
  crypto("XMR", "Monero"),
  crypto("ZEC", "Zcash"),
  crypto("BNB", "BNB"),
  crypto("XRP", "XRP"),
  crypto("TRX", "TRON"),
  crypto("ADA", "Cardano"),
  crypto("XLM", "Stellar"),
  crypto("NEAR", "NEAR Protocol"),
  crypto("BCH", "Bitcoin Cash"),
  crypto("LTC", "Litecoin"),
  { symbol: "SP500", name: "S&P 500 perp", coin: "xyz:SP500", kind: "index", unit: "usd" },
  stock("NVDA", "Nvidia"),
  stock("AAPL", "Apple"),
  stock("MSFT", "Microsoft"),
  stock("GOOGL", "Alphabet"),
  stock("AMZN", "Amazon"),
  stock("META", "Meta"),
  stock("TSLA", "Tesla"),
  { symbol: "OPENAI", name: "OpenAI implied valuation", coin: "io:OAI", kind: "preipo", unit: "usd-billions" },
  { symbol: "ANTHROPIC", name: "Anthropic implied valuation", coin: "io:ANTH", kind: "preipo", unit: "usd-billions" },
];

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
/** Perp dexes the asset list draws on; "" is Hyperliquid's own. */
export const HL_DEXES: readonly string[] = [...new Set(ASSETS.map((a) => (a.coin.includes(":") ? a.coin.split(":")[0] : "")))];

export const CANDLE_WINDOW_MS = 4 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export type Quote = { price: number; changePct: number; at: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number };

type RawCtx = { markPx?: string | null; prevDayPx?: string | null };
type RawMeta = { universe?: { name?: string; isDelisted?: boolean }[] };
type RawCandle = { t?: number; o?: string; h?: string; l?: string; c?: string };

/** Mark price and change against the price 24 hours ago, from a Hyperliquid asset context. */
export function quoteFromCtx(ctx: unknown, at: number): Quote | null {
  if (!ctx || typeof ctx !== "object") return null;
  const { markPx, prevDayPx } = ctx as RawCtx;
  const price = Number(markPx);
  const prev = Number(prevDayPx);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, changePct: Number.isFinite(prev) && prev > 0 ? ((price - prev) / prev) * 100 : 0, at };
}

async function info<T>(body: unknown): Promise<T> {
  const response = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  return (await response.json()) as T;
}

/** One request per dex. Returns quotes for the listed assets and the coins the exchange has delisted. */
export async function fetchQuotes(): Promise<{ quotes: Map<string, Quote>; delisted: Set<string> }> {
  const wanted = new Set(ASSETS.map((a) => a.coin));
  const quotes = new Map<string, Quote>();
  const delisted = new Set<string>();
  const results = await Promise.allSettled(HL_DEXES.map((dex) => info<[RawMeta, unknown[]]>({ type: "metaAndAssetCtxs", dex })));
  const at = Date.now();
  let failures = 0;
  for (const result of results) {
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) { failures += 1; continue; }
    const [meta, ctxs] = result.value;
    (meta?.universe ?? []).forEach((entry, i) => {
      const coin = entry?.name;
      if (!coin || !wanted.has(coin)) return;
      const quote = entry.isDelisted ? null : quoteFromCtx(ctxs?.[i], at);
      if (quote) quotes.set(coin, quote); else delisted.add(coin);
    });
  }
  if (failures === results.length) throw new Error("Hyperliquid is unreachable");
  return { quotes, delisted };
}

/** The last four hours of one-minute candles, oldest first. */
export async function fetchCandles(coin: string): Promise<Candle[]> {
  const endTime = Date.now();
  const raw = await info<RawCandle[]>({ type: "candleSnapshot", req: { coin, interval: "1m", startTime: endTime - CANDLE_WINDOW_MS, endTime } });
  if (!Array.isArray(raw)) throw new Error("Invalid candle data");
  return raw
    .map((c) => ({ time: Number(c?.t), open: Number(c?.o), high: Number(c?.h), low: Number(c?.l), close: Number(c?.c) }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.low > 0)
    .sort((a, b) => a.time - b.time);
}

/** Decimals that keep a price readable at any magnitude: $83,852 / $2,696.60 / $1.5024 / $0.25175. */
export function priceDecimals(value: number) {
  const v = Math.abs(value);
  if (v >= 10_000) return 0;
  if (v >= 10) return 2;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  return 6;
}

export function formatPrice(asset: Pick<Asset, "unit">, value: number, decimals?: number) {
  if (!Number.isFinite(value)) return "--";
  if (asset.unit === "usd-billions") {
    const trillions = Math.abs(value) >= 1000;
    return `$${(trillions ? value / 1000 : value).toFixed(decimals ?? (trillions ? 3 : 1))}${trillions ? "T" : "B"}`;
  }
  const digits = decimals ?? priceDecimals(value);
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Decimals for a price scale whose labels are `step` apart (`top` is the largest label). */
export function scaleDecimals(asset: Pick<Asset, "unit">, step: number, top: number) {
  const scaled = asset.unit === "usd-billions" && Math.abs(top) >= 1000 ? step / 1000 : step;
  if (!(scaled > 0)) return undefined;
  return Math.max(0, Math.min(6, Math.ceil(-Math.log10(scaled)) + 1));
}

export function formatChange(pct: number) {
  if (!Number.isFinite(pct)) return "";
  // U+2212 is a true minus sign, the same width as "+" in a monospace face.
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(2)}%`;
}
