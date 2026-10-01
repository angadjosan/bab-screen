// Market definitions and Hyperliquid helpers shared by app/Markets.tsx.
// Prices come from Hyperliquid's public API (no key): the main perp dex for crypto,
// trade.xyz's HIP-3 dex ("xyz") for the S&P 500 and stocks, EntropyIO's ("io") for the pre-IPO markets.
// The featured chart is TradingView's Advanced Chart widget showing the same Hyperliquid market.

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
   * prices are divided by this as they are read, so the tape and header are per token.
   * TradingView's chart cannot be rescaled and stays per contract.
   */
  lot: number;
  /**
   * The same market on TradingView: "HYPERLIQUID:" for Hyperliquid's own dex, "HIP3XYZ:" for trade.xyz.
   * A market without one (TradingView does not carry EntropyIO) is on the tape but never in the featured slot.
   */
  tv?: string;
};

const crypto = (symbol: string, name: string, coin = symbol, lot = 1): Asset => ({ symbol, name, coin, kind: "crypto", unit: "usd", lot, tv: `HYPERLIQUID:${coin.toUpperCase()}USDC.P` });
const xyz = (symbol: string, name: string, kind: AssetKind = "stock"): Asset => ({ symbol, name, coin: `xyz:${symbol}`, kind, unit: "usd", lot: 1, tv: `HIP3XYZ:${symbol}USDC.P` });

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
  xyz("SP500", "S&P 500 perp", "index"),
  xyz("NVDA", "Nvidia"),
  xyz("AAPL", "Apple"),
  xyz("MSFT", "Microsoft"),
  xyz("GOOGL", "Alphabet"),
  xyz("AMZN", "Amazon"),
  xyz("META", "Meta"),
  xyz("TSLA", "Tesla"),
];

// EntropyIO (HIP-3 dex "io"); trade.xyz does not list these. Drop this group to be trade.xyz-only.
// TradingView has no EntropyIO markets, so these have no chart.
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

const REQUEST_TIMEOUT_MS = 8_000;

export type Quote = { price: number; changePct: number; at: number };

type RawCtx = { markPx?: string | null; prevDayPx?: string | null };
type RawMeta = { universe?: { name?: string; isDelisted?: boolean }[] };

/** Mark price and change against the price 24 hours ago, from a Hyperliquid asset context. */
export function quoteFromCtx(asset: Pick<Asset, "lot">, ctx: unknown, at: number): Quote | null {
  if (!ctx || typeof ctx !== "object") return null;
  const { markPx, prevDayPx } = ctx as RawCtx;
  const price = Number(markPx) / asset.lot;
  const prev = Number(prevDayPx) / asset.lot;
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

/** Where TradingView serves its embeddable widgets from, and what they post to the page as. */
export const TV_WIDGET_ORIGIN = "https://www.tradingview-widget.com";
/**
 * Candle width on the featured chart, in minutes. The widget has no "last 24 hours" setting (its "1D" range is
 * the day so far, from midnight UTC), so the window comes from how many candles fit: 96 of these across the
 * chart box at the zoom set in Markets.module.css is 24 hours. Change the two together.
 */
export const CHART_INTERVAL = "15";

/**
 * The frame address for TradingView's Advanced Chart widget, bare: candles and volume, nothing to click.
 * This is the address TradingView's own embed script (embed-widget-advanced-chart.js) builds; the frame is
 * created directly because that script leaves a listener behind on every use, and the chart changes all day.
 */
export function chartUrl(symbol: string) {
  const page = window.location;
  const settings = {
    autosize: true,
    symbol,
    interval: CHART_INTERVAL,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    theme: "dark",
    style: "1",
    locale: "en",
    backgroundColor: "#0b0e13",
    gridColor: "#232a34",
    hide_top_toolbar: true,
    hide_side_toolbar: true,
    hide_legend: true,
    hide_volume: false,
    allow_symbol_change: false,
    save_image: false,
    withdateranges: false,
    details: false,
    hotlist: false,
    calendar: false,
    support_host: "https://www.tradingview.com",
    utm_source: page.hostname,
    utm_medium: "widget_new",
    utm_campaign: "advanced-chart",
    "page-uri": `${page.host}${page.pathname}`,
  };
  return `${TV_WIDGET_ORIGIN}/embed-widget/advanced-chart/?locale=en#${encodeURIComponent(JSON.stringify(settings))}`;
}

export function formatChange(pct: number) {
  if (!Number.isFinite(pct)) return "";
  // U+2212 is a true minus sign, the same width as "+" in a monospace face.
  return `${pct < 0 ? "−" : "+"}${Math.abs(pct).toFixed(2)}%`;
}
