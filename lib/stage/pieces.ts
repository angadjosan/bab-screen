// Reads the bodies of Worm's chart and table blocks. They are meant to be JSON, but GLM-5.3 sometimes writes a table as
// XML instead ("<columns><col>Time</col></columns><rows><row><cell>1 PM</cell>…"), so tables are read either way. A
// block that cannot be read is left off the screen entirely, rather than leaving an empty space where it would be.

import type { StageBlock } from "./state";
import { readDiagram } from "./diagram-layout";

export type ChartSpec = { type?: "line" | "bar"; title?: string; unit?: string; x?: string[]; series?: { name?: string; values?: number[] }[] };
export type TableSpec = { title: string | null; columns: string[]; rows: string[][] };

export function parseJson<T>(body: string): T | null {
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

const decode = (text: string) => text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').trim();
const tagContents = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1]);

function tableFromXml(body: string): TableSpec | null {
  const rows = tagContents(body, "row").map((row) => tagContents(row, "cell").map(decode));
  if (!rows.length) return null;
  return { title: tagContents(body, "title").map(decode)[0] ?? null, columns: tagContents(body, "col").map(decode), rows };
}

function tableFromJson(body: string): TableSpec | null {
  const spec = parseJson<{ title?: unknown; columns?: unknown[]; rows?: unknown[][] }>(body);
  if (!spec || !Array.isArray(spec.rows) || !spec.rows.length) return null;
  const cell = (value: unknown) => String(value ?? "");
  return {
    title: typeof spec.title === "string" ? spec.title : null,
    columns: Array.isArray(spec.columns) ? spec.columns.map(cell) : [],
    rows: spec.rows.filter(Array.isArray).map((row) => row.map(cell)),
  };
}

export function readTable(body: string): TableSpec | null {
  return tableFromJson(body) ?? tableFromXml(body);
}

export function readChart(body: string): ChartSpec | null {
  const spec = parseJson<ChartSpec>(body);
  const hasValues = spec?.series?.some((series) => Array.isArray(series.values) && series.values.length);
  return spec && hasValues ? spec : null;
}

const READERS: Record<Exclude<StageBlock["kind"], "say">, (body: string) => unknown> = {
  diagram: readDiagram,
  chart: readChart,
  table: readTable,
  html: (body) => (body.replace(/<[^>]*>/g, "").trim() || /<(svg|img)\b/i.test(body) ? body : null),
};

/** Whether a visual block has, or may yet have, something to draw: still streaming, or finished and readable. */
export function willDraw(block: StageBlock): boolean {
  if (block.kind === "say") return false;
  return !block.done || READERS[block.kind](block.body) !== null;
}
