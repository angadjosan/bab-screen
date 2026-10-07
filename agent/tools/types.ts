// What every tool is: a name, a small flat JSON schema for the model, a parser that turns the
// model's (untrusted) arguments into typed ones, and the code that runs it.

import type { Who } from "../db";

export type Source = "slack" | "voice" | "http" | "scheduler";

/** One request from a person (or the scheduler), shared by everything that runs for it. */
export type TurnContext = {
  who: Who & { source: Source };
  /** The Slack conversation the request came from, if any. */
  channel: string | null;
  threadTs: string | null;
  /** Slack: "dm" or "channel". */
  place?: string;
  /** The message as Slack sent it, <@U123> mentions intact (games need the ids), when the caller has it. */
  rawText?: string | null;
  /** Spoken aloud and posted to Slack during this turn, so the final answer is not repeated. */
  spoken: string[];
  replied: string[];
  /** JARVIS_DRY_RUN=1: no Spotify, speech, screen or Slack side effects. */
  dryRun: boolean;
  /** Side effects skipped in dry-run mode, for tests and the log. */
  dryRunLog: string[];
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolDef<A> = {
  name: string;
  description: string;
  parameters: JsonSchema;
  parse(raw: Record<string, unknown>): A;
  run(args: A, ctx: TurnContext): Promise<unknown>;
};

export type AnyTool = ToolDef<unknown>;

export function defineTool<A>(tool: ToolDef<A>): AnyTool {
  return tool as unknown as AnyTool;
}

export class ArgError extends Error {}

/** Control characters (tab and newline excepted), zero-width and bidi marks, and the BOM. */
const INVISIBLE_RANGES: Array<[number, number]> = [
  [0x0000, 0x0008],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
];

const isInvisible = (code: number) => INVISIBLE_RANGES.some(([low, high]) => code >= low && code <= high);

function blankInvisible(value: string): string {
  return Array.from(value, (char) => (isInvisible(char.charCodeAt(0)) ? " " : char)).join("");
}

/** Plain text: control characters removed, whitespace collapsed unless `multiline`, clamped. */
export function plain(value: string, max: number, multiline = false): string {
  const text = blankInvisible(value);
  const tidy = multiline ? text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() : text.replace(/\s+/g, " ").trim();
  const points = Array.from(tidy);
  return points.length > max ? `${points.slice(0, max - 1).join("").trimEnd()}…` : tidy;
}

export function str(raw: Record<string, unknown>, key: string, max: number, options: { optional?: boolean; multiline?: boolean } = {}): string {
  const value = raw[key];
  if (value === undefined || value === null || value === "") {
    if (options.optional) return "";
    throw new ArgError(`${key} is required`);
  }
  if (typeof value !== "string" && typeof value !== "number") throw new ArgError(`${key} must be a string`);
  const text = plain(String(value), max, options.multiline);
  if (!text && !options.optional) throw new ArgError(`${key} is empty`);
  return text;
}

export function int(raw: Record<string, unknown>, key: string, min: number, max: number, fallback?: number): number {
  const value = raw[key];
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw new ArgError(`${key} is required`);
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new ArgError(`${key} must be a number`);
  return Math.max(min, Math.min(max, Math.round(number)));
}

export function oneOf<T extends string>(raw: Record<string, unknown>, key: string, values: readonly T[], fallback?: T): T {
  const value = typeof raw[key] === "string" ? (raw[key] as string).trim().toLowerCase() : raw[key];
  if ((value === undefined || value === "") && fallback !== undefined) return fallback;
  if (typeof value === "string" && (values as readonly string[]).includes(value)) return value as T;
  throw new ArgError(`${key} must be one of ${values.join(", ")}`);
}

export function bool(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  return value === true || value === "true" || value === 1;
}
