"use client";

import { useEffect, useState, type CSSProperties } from "react";
import styles from "./Clock.module.css";

const ZONE = "America/Los_Angeles";
const clockFormat = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "numeric", minute: "2-digit", hour12: true });

/**
 * Ethereum proposes a block at the start of every 12-second slot, counted from the beacon chain's genesis
 * (2020-12-01 12:00:23 UTC). A block's timestamp is its slot's start, so the next block is due at the next
 * slot boundary. Worked out from the clock alone: no node is asked.
 */
const BEACON_GENESIS_MS = 1_606_824_023_000;
const SLOT_MS = 12_000;
const RING_RADIUS = 17;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Berkeley time as h:mm, whatever the computer's zone, read again on each minute. */
function useMinute(): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      const current = new Date();
      setNow(current);
      timer = window.setTimeout(tick, 60_000 - (current.getTime() % 60_000) + 50);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return now;
}

/** The current slot's number, and how far into it the page was when the slot began to be drawn. */
function useSlot(): { slot: number; elapsedMs: number } | null {
  const [state, setState] = useState<{ slot: number; elapsedMs: number } | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const tick = () => {
      const sinceGenesis = Date.now() - BEACON_GENESIS_MS;
      const elapsedMs = sinceGenesis % SLOT_MS;
      setState({ slot: Math.floor(sinceGenesis / SLOT_MS), elapsedMs });
      timer = window.setTimeout(tick, SLOT_MS - elapsedMs + 20);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);
  return state;
}

/**
 * A ring around the Ethereum mark that fills in gold over the 12 seconds until the next block, and flashes as it
 * lands. Restarted at each slot, so it is drawn by CSS alone in between.
 */
function BlockRing() {
  const slot = useSlot();
  const progress = slot ? ({ "--ring-length": RING_LENGTH, animationDelay: `-${slot.elapsedMs}ms` } as CSSProperties) : undefined;
  return (
    <svg className={styles.ring} viewBox="0 0 40 40" width={40} height={40} aria-hidden="true">
      <circle className={styles.track} cx={20} cy={20} r={RING_RADIUS} />
      {slot && <circle key={slot.slot} className={styles.progress} cx={20} cy={20} r={RING_RADIUS} style={progress} />}
      <path className={styles.ether} d="M20 9.5 13.5 20.3 20 24.1 26.5 20.3Z M20 25.4 13.5 21.6 20 30.5 26.5 21.6Z" />
    </svg>
  );
}

/** The time, next to the B@B mark, and beside it how long until the next Ethereum block. */
export function Clock() {
  const now = useMinute();
  return (
    <div className={styles.clock}>
      {now && <time className={styles.time} dateTime={now.toISOString()}>{clockFormat.format(now).replace(/\s?[AP]M$/, "")}</time>}
      <BlockRing />
    </div>
  );
}
