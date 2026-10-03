// Exa web search (https://api.exa.ai, plain fetch). Only lookup_person uses it, through a fixed
// query it builds itself; the model never gets a general fetch or search tool. Results are
// untrusted text: callers pass them to the model as data.

import { addSpend } from "./db";
import { config } from "./config";
import { overCap } from "./llm";

/** Exa's list prices: a search with up to 25 results, plus page text per result. */
const SEARCH_USD = 0.005;
const TEXT_USD_PER_RESULT = 0.001;
const TIMEOUT_MS = 15_000;

export type ExaResult = { title: string | null; url: string; publishedDate: string | null; author: string | null; text: string | null; image: string | null };

export async function exaSearch(query: string, options: { numResults?: number; maxCharacters?: number } = {}): Promise<{ ok: boolean; results: ExaResult[]; error?: string }> {
  const key = config.exaKey();
  if (!key) return { ok: false, results: [], error: "EXA_API_KEY is not set" };
  if (overCap()) return { ok: false, results: [], error: "daily spend cap reached" };
  const numResults = Math.max(1, Math.min(10, options.numResults ?? 5));
  try {
    const response = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({ query: query.slice(0, 300), type: "auto", numResults, contents: { text: { maxCharacters: options.maxCharacters ?? 800 } } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, results: [], error: `exa_http_${response.status}` };
    const payload = (await response.json()) as { results?: Array<Record<string, unknown>>; costDollars?: { total?: number } };
    const results = (payload.results ?? []).flatMap((item): ExaResult[] => {
      const url = typeof item.url === "string" && /^https:\/\//.test(item.url) ? item.url : null;
      if (!url) return [];
      const text = (key: string) => (typeof item[key] === "string" && (item[key] as string).trim() ? (item[key] as string).trim() : null);
      return [{ title: text("title"), url, publishedDate: text("publishedDate"), author: text("author"), text: text("text"), image: text("image") }];
    });
    const reported = payload.costDollars?.total;
    addSpend("exa", "search", typeof reported === "number" && reported >= 0 ? reported : SEARCH_USD + TEXT_USD_PER_RESULT * results.length);
    return { ok: true, results };
  } catch (error) {
    return { ok: false, results: [], error: error instanceof Error && error.name === "TimeoutError" ? "exa_timeout" : "exa_unreachable" };
  }
}
