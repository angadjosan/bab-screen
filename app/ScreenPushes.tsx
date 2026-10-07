"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ScreenState } from "../lib/screen-state";
import { Game } from "./Game";
import { Leaderboard } from "./Leaderboard";
import { PinnedThread } from "./PinnedThread";
import styles from "./widgets/Widgets.module.css";

/** Wait this long before reconnecting to the screen stream after it drops. */
const STREAM_RETRY_MS = 3_000;
/** Out of touch with the server this long, the page drops everything the agent put up. */
const STREAM_FALLBACK_MS = 60_000;

/**
 * What the Slack agent has put on the screen (lib/screen-state.ts), from one EventSource on /api/screen/stream; null
 * until the first message, and again after a long drop. A short drop keeps the last state up while it reconnects.
 */
export function useScreenState(): ScreenState | null {
  const [state, setState] = useState<ScreenState | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let fallback: number | undefined;
    // Within one connection a state older than the last one (sent on connect while a change was going out) is
    // ignored; a new connection starts over, since the server may have started over too.
    let version = -1;

    const connect = () => {
      version = -1;
      source = new EventSource("/api/screen/stream");
      source.onmessage = (event) => {
        try {
          const next = JSON.parse(event.data) as ScreenState;
          if (typeof next?.version !== "number" || next.version < version) return;
          version = next.version;
          window.clearTimeout(fallback);
          fallback = undefined;
          setState(next);
        } catch {
          // Not a state: ignore it, the next change sends the whole state again.
        }
      };
      // EventSource retries by itself after a dropped connection, but not after an error status; closing and
      // opening a new one covers both.
      source.onerror = () => {
        source?.close();
        window.clearTimeout(retry);
        retry = window.setTimeout(connect, STREAM_RETRY_MS);
        fallback ??= window.setTimeout(() => setState(null), STREAM_FALLBACK_MS);
      };
    };

    connect();
    return () => {
      source?.close();
      window.clearTimeout(retry);
      window.clearTimeout(fallback);
    };
  }, []);

  return state;
}

/**
 * The game, leaderboard and pinned thread the agent has put up, in that order: each one that is in any slot (the
 * agent's presets and show_widget) and has something to show. This page keeps its own layout, so where the agent
 * put it does not matter.
 */
export function pushedPieces(state: ScreenState | null): ReactNode[] {
  if (!state) return [];
  const shown = new Set(Object.values(state.slots ?? {}));
  const pieces: ReactNode[] = [];
  if (shown.has("game") && state.game) pieces.push(<Game key="game" game={state.game} />);
  if (shown.has("leaderboard") && state.leaderboard?.rows.length) pieces.push(<Leaderboard key="leaderboard" board={state.leaderboard} />);
  if (shown.has("pinned_thread") && state.pinnedThread) pieces.push(<PinnedThread key="thread" thread={state.pinnedThread} />);
  return pieces;
}

/** The agent's preset "markets" asks for prices and news only, which is what focus mode shows. */
export const asksForFocus = (state: ScreenState | null) => state?.preset === "markets";

/** Pushed pieces stacked in the middle column, where the featured market goes back once they are gone. */
export function ScreenPushes({ pieces }: { pieces: ReactNode[] }) {
  return <div className={styles.pushed}>{pieces.map((piece, index) => <div key={index} className={styles.fill}>{piece}</div>)}</div>;
}
