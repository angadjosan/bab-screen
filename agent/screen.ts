// Client for the TV: POST /api/screen on the Next app (127.0.0.1 only, x-screen-secret header).
// The Next side validates slot, widget and preset names against app/widgets/registry.ts (plain data,
// imported here too for presets and the prompt's slot guide); this side only shapes the body.

import { PRESETS, SLOTS, WIDGETS, WIDGET_IDS, type Preset } from "../app/widgets/registry";
import type { GameScreen } from "../lib/screen-state";
import { config } from "./config";

export { PRESETS, type Preset, type GameScreen };

export type PersonCard = { name: string; headline?: string; summary?: string; links?: { label: string; url: string }[]; imageUrl?: string };
export type PinnedThread = { channel: string; ts: string; author?: string; text: string; replies?: { author: string; text: string }[]; permalink?: string };

export type ScreenOp =
  | { op: "set_preset"; preset: Preset }
  | { op: "show_widget"; slot: string; widget: string }
  | { op: "banner"; text: string; ttlSeconds?: number }
  | { op: "person"; card: PersonCard; ttlSeconds?: number }
  | { op: "clear_overlays" }
  | { op: "pin_thread"; thread: PinnedThread }
  | { op: "unpin_thread" }
  | { op: "leaderboard"; title: string; rows: { name: string; score: number }[] }
  | { op: "game"; game: GameScreen }
  | { op: "clear_game" };

export type ScreenResult = { ok: boolean; status: number | null; error?: string; body?: unknown; dryRun?: boolean };

const TIMEOUT_MS = 5_000;

/** Turns "game night", "Game-Night" and "gamenight" into a preset name, or null. */
export function presetName(value: string): Preset | null {
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((PRESETS as readonly string[]).includes(key)) return key as Preset;
  if (key === "gamenight" || key === "games") return "game_night";
  if (key === "normal" || key === "home") return "default";
  return null;
}

export async function pushScreen(op: ScreenOp, options: { dryRun?: boolean } = {}): Promise<ScreenResult> {
  if (options.dryRun ?? config.dryRun()) {
    console.log("[jarvis] dry run: screen", JSON.stringify(op));
    return { ok: true, status: null, dryRun: true };
  }
  const secret = config.screenSecret();
  if (!secret) return { ok: false, status: null, error: "SCREEN_SECRET is not set, so the TV would refuse this" };
  try {
    const response = await fetch(`${config.nextUrl()}/api/screen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-screen-secret": secret },
      body: JSON.stringify(op),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `http_${response.status}`;
      return { ok: false, status: response.status, error: message, body };
    }
    return { ok: true, status: response.status, body };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { ok: false, status: null, error: name === "TimeoutError" ? "screen_timeout" : "screen_unreachable (is the Next app running on :3000?)" };
  }
}

/** Current layout and overlays from GET /api/screen, or null. Used for prompt context and slot names. */
export async function readScreen(): Promise<unknown | null> {
  try {
    const response = await fetch(`${config.nextUrl()}/api/screen`, { signal: AbortSignal.timeout(2_000), headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** Slots and the widgets that fit each, from the registry the TV checks against (for the prompt). */
export function widgetGuide(): string {
  return SLOTS.map((slot) => `${slot}: ${WIDGET_IDS.filter((id) => WIDGETS[id].fits.includes(slot)).join(", ")}`).join("\n");
}

/**
 * pin_thread, leaderboard and game only store data; it shows once a slot holds the widget. Puts `widget`
 * in `slot` unless some slot already holds it.
 */
export async function ensureWidget(widget: "pinned_thread" | "leaderboard" | "game", slot: "center" | "side" | "left", options: { dryRun?: boolean } = {}): Promise<ScreenResult | null> {
  const state = (await readScreen()) as { slots?: Record<string, string> } | null;
  if (state?.slots && Object.values(state.slots).includes(widget)) return null;
  return pushScreen({ op: "show_widget", slot, widget }, options);
}
