"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { CalendarEvent, EventsResponse } from "@/lib/events";
import { isSpeakable, plainSpeech } from "@/lib/stage/answer-format";
import { willDraw } from "@/lib/stage/pieces";
import type { StageBlock, StageState } from "@/lib/stage/state";
import { Visual } from "./StagePieces";
import styles from "./Stage.module.css";

const IDLE: StageState = { turn: 0, phase: "idle", heard: "", heardFinal: false, ack: null, activity: null, blocks: [], error: null, closesAt: null, listenUntil: null };
const EVENTS_POLL_MS = 60_000;
/** Sizes for Worm's words, largest first: the largest at which they fit is used. */
const SAY_SIZES = [40, 34, 30, 26];
const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** The stage as the server holds it (lib/stage/state.ts), live over /api/stage/stream. */
export function useStage(): StageState {
  const [state, setState] = useState<StageState>(IDLE);
  useEffect(() => {
    const stream = new EventSource("/api/stage/stream");
    stream.onmessage = (message) => {
      try {
        setState(JSON.parse(String(message.data)) as StageState);
      } catch {
        // A malformed message is skipped; the next one carries the whole state again.
      }
    };
    return () => stream.close();
  }, []);
  return state;
}

/** One line for the calendar while the stage has the screen: what is on now, or that nothing is. */
function useEventLine(active: boolean): string {
  const [line, setLine] = useState("No current events");
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const poll = async () => {
      try {
        const body = (await (await fetch("/api/events", { cache: "no-store" })).json()) as EventsResponse;
        const now = Date.now();
        const live = body.events.find((event: CalendarEvent) => !event.allDay && Date.parse(event.start) <= now && Date.parse(event.end) > now);
        if (alive) setLine(live ? `Calendar: ${live.title}` : "No current events");
      } catch {
        // Keep the last line.
      }
    };
    void poll();
    const timer = window.setInterval(poll, EVENTS_POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, [active]);
  return line;
}

function Heard({ state }: { state: StageState }) {
  return (
    <p className={cx(styles.heard, state.heardFinal && styles.heardFinal)}>
      {state.phase === "listening" && <span className={styles.mic} aria-hidden="true" />}
      <span>{state.heard || "Listening…"}</span>
    </p>
  );
}

/**
 * Sets the words to the largest of SAY_SIZES at which they fit their column, again whenever they change. Returns
 * whether even the smallest overflows, so the oldest lines can be let slide out of view.
 */
function useFitText(box: React.RefObject<HTMLDivElement | null>, content: string): boolean {
  const [crowded, setCrowded] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = () => {
      const size = SAY_SIZES.find((px) => {
        element.style.setProperty("--say-size", `${px}px`);
        return element.scrollHeight <= element.clientHeight;
      });
      setCrowded(size === undefined);
    };
    fit();
    // The column narrows when a picture arrives beside the words, which makes them taller: fit them again.
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, content]);
  return crowded;
}

function Says({ blocks, state }: { blocks: StageBlock[]; state: StageState }) {
  const box = useRef<HTMLDivElement>(null);
  const crowded = useFitText(box, blocks.map((block) => block.body).join("\n") + (state.activity ?? "") + (state.error ?? ""));
  return (
    <div ref={box} className={cx(styles.says, crowded && styles.saysCrowded)}>
      {state.ack && <p className={styles.ack}>{state.ack}</p>}
      {blocks.map((block, i) => <p key={i} className={cx(styles.say, !block.done && styles.sayLive)}>{plainSpeech(block.body)}</p>)}
      {state.activity && <p className={styles.activity}><span className={styles.spinner} aria-hidden="true" />{state.activity}</p>}
      {state.error && <p className={styles.error}>{state.error}</p>}
    </div>
  );
}

/** The bar along the stage's foot that drains until the screen is handed back. */
function Closing({ closesAt }: { closesAt: number | null }) {
  if (!closesAt) return null;
  const left = Math.max(0, closesAt - Date.now());
  return <span key={closesAt} className={styles.closing} style={{ animationDuration: `${left}ms` } as CSSProperties} aria-hidden="true" />;
}

/**
 * Worm's stage, over the rest of the screen while someone is asking or being answered: what they said at the top
 * right in their own words, Worm's answer on the left in large type with anything it draws beside it, and a line for
 * the calendar along the foot.
 */
export function StagePanel({ state }: { state: StageState }) {
  const on = state.phase !== "idle";
  const eventLine = useEventLine(on);
  const says = state.blocks.filter((block) => block.kind === "say" && isSpeakable(plainSpeech(block.body)));
  // Only what will draw gets room: a block the model wrote in a form that cannot be read is left out.
  const visuals = state.blocks.filter(willDraw);
  const answering = Boolean(state.ack || state.blocks.length || state.activity || state.error);
  return (
    <section className={cx(styles.stage, on && styles.on)} aria-hidden={!on} aria-live="polite" aria-label="Worm">
      <Heard state={state} />
      <div className={cx(styles.answer, answering && styles.answerOn, visuals.length > 0 && styles.withVisuals)}>
        <Says blocks={says} state={state} />
        {visuals.length > 0 && <div className={styles.visuals}>{visuals.map((block, i) => <Visual key={i} block={block} />)}</div>}
      </div>
      <footer className={styles.foot}>
        <p className={styles.eventLine}>{eventLine}</p>
        <Closing closesAt={state.closesAt} />
      </footer>
    </section>
  );
}
