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
  /**
   * Tokens per contract. Hyperliquid quotes its "k" markets (kSHIB, kPEPE, kBONK) per 1,000 tokens;
   * prices are divided by this (and volumes multiplied) as they are read, so everything on screen is per token.
   */
  lot: number;
};

const crypto = (symbol: string, name: string, coin = symbol, lot = 1): Asset => ({ symbol, name, coin, kind: "crypto", unit: "usd", lot });
const stock = (symbol: string, name: string): Asset => ({ symbol, name, coin: `xyz:${symbol}`, kind: "stock", unit: "usd", lot: 1 });

// The 30 largest cryptocurrencies by market cap (CoinGecko, 30 Sep 2026) that trade on Hyperliquid's own perp dex,
// largest first. Stablecoins, tokenised dollars/gold and coins Hyperliquid does not list are left out.
const CRYPTO: readonly Asset[] = [
  crypto("BTC", "Bitcoin"),
  crypto("ETH", "Ethereum"),
  crypto("BNB", "BNB"),
  crypto("XRP", "XRP"),
  crypto("SOL", "Solana"),
  crypto("TRX", "TRON"),
  crypto("ZEC", "Zcash"),
  crypto("HYPE", "Hyperliquid"),
  crypto("DOGE", "Dogecoin"),
  crypto("LINK", "Chainlink"),
  crypto("XMR", "Monero"),
  crypto("ADA", "Cardano"),
  crypto("XLM", "Stellar"),
  crypto("NEAR", "NEAR Protocol"),
  crypto("BCH", "Bitcoin Cash"),
  crypto("UNI", "Uniswap"),
  crypto("LTC", "Litecoin"),
  crypto("CC", "Canton"),
  crypto("AVAX", "Avalanche"),
  crypto("SUI", "Sui"),
  crypto("HBAR", "Hedera"),
  crypto("GRAM", "Gram (formerly Toncoin)"),
  crypto("TAO", "Bittensor"),
  crypto("SHIB", "Shiba Inu", "kSHIB", 1000),
  crypto("ENA", "Ethena"),
  crypto("PUMP", "Pump.fun"),
  crypto("AAVE", "Aave"),
  crypto("ONDO", "Ondo"),
  crypto("MNT", "Mantle"),
  crypto("DOT", "Polkadot"),
];

// trade.xyz (HIP-3 dex "xyz").
const STOCKS: readonly Asset[] = [
  { symbol: "SP500", name: "S&P 500 perp", coin: "xyz:SP500", kind: "index", unit: "usd", lot: 1 },
  stock("NVDA", "Nvidia"),
  stock("AAPL", "Apple"),
  stock("MSFT", "Microsoft"),
  stock("GOOGL", "Alphabet"),
  stock("AMZN", "Amazon"),
  stock("META", "Meta"),
  stock("TSLA", "Tesla"),
];

// EntropyIO (HIP-3 dex "io"); trade.xyz does not list these. Drop this group to be trade.xyz-only.
const PRE_IPO: readonly Asset[] = [
  { symbol: "OPENAI", name: "OpenAI implied valuation", coin: "io:OAI", kind: "preipo", unit: "usd-billions", lot: 1 },
  { symbol: "ANTHROPIC", name: "Anthropic implied valuation", coin: "io:ANTH", kind: "preipo", unit: "usd-billions", lot: 1 },
];

// Order is the rotation order and the tape order.
export const ASSETS: readonly Asset[] = [...CRYPTO, ...STOCKS, ...PRE_IPO];

export const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
/** Perp dexes the asset list draws on; "" is Hyperliquid's own. */
export const HL_DEXES: readonly string[] = [...new Set(ASSETS.map((a) => (a.coin.includes(":") ? a.coin.split(":")[0] : "")))];

/** Candles are fetched at this resolution (app/Markets.tsx groups them into wider bars) ... */
export const CANDLE_INTERVAL = "1m";
/** ... over this much history. */
export const CANDLE_WINDOW_MS = 4 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 8_000;

export type Quote = { price: number; changePct: number; at: number };
/** `volume` is in units of the asset (tokens, shares, or billions of valuation), not dollars. */
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

type RawCtx = { markPx?: string | null; prevDayPx?: string | null };
type RawMeta = { universe?: { name?: string; isDelisted?: boolean }[] };
type RawCandle = { t?: number; i?: string; o?: string; h?: string; l?: string; c?: string; v?: string };

/** Mark price and change against the price 24 hours ago, from a Hyperliquid asset context. */
export function quoteFromCtx(asset: Pick<Asset, "lot">, ctx: unknown, at: number): Quote | null {
  if (!ctx || typeof ctx !== "object") return null;
  const { markPx, prevDayPx } = ctx as RawCtx;
  const price = Number(markPx) / asset.lot;
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
  const wanted = new Map(ASSETS.map((a) => [a.coin, a]));
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
      const asset = coin ? wanted.get(coin) : undefined;
      if (!coin || !asset) return;
      const quote = entry.isDelisted ? null : quoteFromCtx(asset, ctxs?.[i], at);
      if (quote) quotes.set(coin, quote); else delisted.add(coin);
    });
  }
  if (failures === results.length) throw new Error("Hyperliquid is unreachable");
  return { quotes, delisted };
}

/** One candle as Hyperliquid sends it (REST snapshot or "candle" WebSocket channel), per token; null if malformed. */
export function candleFromRaw(asset: Pick<Asset, "lot">, raw: unknown): Candle | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as RawCandle;
  if (c.i !== undefined && c.i !== CANDLE_INTERVAL) return null;
  const volume = Number(c.v) * asset.lot;
  const candle = { time: Number(c.t), open: Number(c.o) / asset.lot, high: Number(c.h) / asset.lot, low: Number(c.l) / asset.lot, close: Number(c.c) / asset.lot, volume: Number.isFinite(volume) ? volume : 0 };
  return [candle.time, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite) && candle.low > 0 ? candle : null;
}

/** The last CANDLE_WINDOW_MS of candles, oldest first. */
export async function fetchCandles(asset: Pick<Asset, "coin" | "lot">): Promise<Candle[]> {
  const endTime = Date.now();
  const raw = await info<unknown[]>({ type: "candleSnapshot", req: { coin: asset.coin, interval: CANDLE_INTERVAL, startTime: endTime - CANDLE_WINDOW_MS, endTime } });
  if (!Array.isArray(raw)) throw new Error("Invalid candle data");
  return raw
    .map((c) => candleFromRaw(asset, c))
    .filter((c): c is Candle => c !== null)
    .sort((a, b) => a.time - b.time);
}

/** Decimals that keep a price readable at any magnitude: $83,852 / $2,696.60 / $1.5024 / $0.25175 / $0.000005835. */
export function priceDecimals(value: number) {
  const v = Math.abs(value);
  if (v >= 10_000) return 0;
  if (v >= 10) return 2;
  if (v >= 1) return 4;
  if (v >= 0.01) return 5;
  // Four significant digits, which is as fine as Hyperliquid quotes such prices.
  return v > 0 ? Math.min(12, Math.ceil(-Math.log10(v)) + 3) : 2;
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

/** Labels for a price scale: the fewest decimals that tell every tick apart, the same for all of them. */
export function formatScale(asset: Pick<Asset, "unit">, values: readonly number[]) {
  const trillions = asset.unit === "usd-billions" && Math.max(...values.map(Math.abs)) >= 1000;
  const shown = values.map((v) => (trillions ? v / 1000 : v));
  let decimals = 0;
  while (decimals < 12 && shown.some((v) => Math.abs(v * 10 ** decimals - Math.round(v * 10 ** decimals)) > 1e-6 * Math.max(1, Math.abs(v * 10 ** decimals)))) decimals += 1;
  // Dollars and cents, never dollars and dimes.
  if (asset.unit === "usd" && decimals === 1) decimals = 2;
  return values.map((v) => formatPrice(asset, v, decimals));
}

export function formatChange(pct: number) {
  if (!Number.isFinite(pct)) return "";
  // U+2212 is a true minus sign, the same width as "+" in a monospace face.
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(2)}%`;
}
