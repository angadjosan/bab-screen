// The screen's widgets, its slots and its presets, as plain data: which tile may go where, and what each preset
// puts in each slot. No React here, so the server (lib/screen-state.ts, which checks every POST /api/screen
// against it) and the agent process can import it too. app/page.tsx maps each widget id to its component.
//
// The stage keeps today's three columns under the masthead (app/globals.css). Each column is cut into a few
// fixed slots: a main slot that takes the height that is left, and small ones above or below it that hold the
// one tile made for them. A slot can also be empty ("none").

/** Top to bottom, left to right: the masthead's tape, the left column, the middle, the right column. */
export const SLOTS = ["tape", "left", "left_bottom", "center", "side_top", "side", "side_bottom"] as const;
export type Slot = (typeof SLOTS)[number];

export const WIDGET_IDS = [
  "none",
  "ticker",
  "featured_market",
  "feed",
  "coin_flip",
  "now_playing",
  "carousel",
  "events",
  "leaderboard",
  "pinned_thread",
  "game",
] as const;
export type WidgetId = (typeof WIDGET_IDS)[number];

export type WidgetInfo = {
  label: string;
  /** Slots it is drawn for. Anything else is refused by POST /api/screen. */
  fits: readonly Slot[];
  /**
   * Shown only while it has something to show (a leaderboard with rows, a pinned thread). While it has nothing,
   * its slot shows what the default preset puts there instead, so a preset never leaves a blank tile.
   */
  needsData?: boolean;
};

// The three slots that take the height that is left in their column. The tiles that fill a box go in any of them.
const MAIN: readonly Slot[] = ["left", "center", "side"];

export const WIDGETS: Record<WidgetId, WidgetInfo> = {
  none: { label: "Nothing", fits: SLOTS },
  ticker: { label: "Ticker tape", fits: ["tape"] },
  // The chart's 24-hour window is tuned to the middle column's 816px (README "Market data").
  featured_market: { label: "Featured market and chart", fits: ["center"] },
  // Turns into the note on a newsworthy token while one is featured (app/Feed.tsx).
  feed: { label: "News and posts feed", fits: MAIN },
  // The QR tile under the feed; the full-screen flip it starts covers the whole stage wherever it sits.
  coin_flip: { label: "Coin flip", fits: ["left_bottom"] },
  // The song playing in Spotify, and the Jam QR for its minute (the right column makes room for it).
  now_playing: { label: "Now playing and Jam QR", fits: ["side_top"] },
  // Spotted photos, quotes and chumming photos in one rotation (SpotCard in app/page.tsx).
  carousel: { label: "Spots, quotes and chumming photos", fits: MAIN },
  // Under the carousel it is the two-row block that opens only while there are events; in a main slot it lists
  // as many as fit.
  events: { label: "Upcoming events", fits: [...MAIN, "side_bottom"] },
  leaderboard: { label: "Leaderboard", fits: MAIN, needsData: true },
  pinned_thread: { label: "Pinned Slack thread", fits: MAIN, needsData: true },
  // The game running now: Mafia's phase, clock and players, or the poker table and who pays whom (app/Game.tsx).
  game: { label: "Game: Mafia or poker", fits: MAIN, needsData: true },
};

export const PRESETS = ["default", "markets", "news", "party", "game_night"] as const;
export type Preset = (typeof PRESETS)[number];
export type Layout = Record<Slot, WidgetId>;

export const PRESET_LAYOUTS: Record<Preset, Layout> = {
  // Exactly the screen as it was before there were presets.
  default: {
    tape: "ticker",
    left: "feed",
    left_bottom: "coin_flip",
    center: "featured_market",
    side_top: "now_playing",
    side: "carousel",
    side_bottom: "events",
  },
  // Prices, the chart and the news; no photos or games.
  markets: {
    tape: "ticker",
    left: "feed",
    left_bottom: "none",
    center: "featured_market",
    side_top: "now_playing",
    side: "events",
    side_bottom: "none",
  },
  // The feed at the width of the middle column, with the calendar beside it.
  news: {
    tape: "ticker",
    left: "events",
    left_bottom: "none",
    center: "feed",
    side_top: "now_playing",
    side: "carousel",
    side_bottom: "none",
  },
  // The photos big in the middle, the song and the feed on the right, the calendar on the left.
  party: {
    tape: "ticker",
    left: "events",
    left_bottom: "none",
    center: "carousel",
    side_top: "now_playing",
    side: "feed",
    side_bottom: "none",
  },
  // The game in the middle (the chart while none is running), the leaderboard on the left (the feed while it is
  // empty) and the coin flip on.
  game_night: {
    tape: "ticker",
    left: "leaderboard",
    left_bottom: "coin_flip",
    center: "game",
    side_top: "now_playing",
    side: "carousel",
    side_bottom: "events",
  },
};

export const isSlot = (value: unknown): value is Slot => typeof value === "string" && (SLOTS as readonly string[]).includes(value);
export const isWidgetId = (value: unknown): value is WidgetId => typeof value === "string" && (WIDGET_IDS as readonly string[]).includes(value);
export const isPreset = (value: unknown): value is Preset => typeof value === "string" && (PRESETS as readonly string[]).includes(value);
export const fits = (widget: WidgetId, slot: Slot) => WIDGETS[widget].fits.includes(slot);
