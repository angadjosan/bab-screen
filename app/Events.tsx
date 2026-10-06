"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent, EventsResponse } from "../lib/events";
import styles from "./Events.module.css";

const POLL_MS = 5 * 60_000;
/** While the server is still doing its first download, or has nothing, ask again sooner. */
const UNSETTLED_POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** The clock is re-read at the next start or end, and at least this often (midnight, a machine waking from sleep). */
const MAX_TICK_MS = 30_000;
const DAY_MS = 86_400_000;
/** Only the week ahead is listed: an event has to start within this long from now (or be under way). */
const WEEK_AHEAD_MS = 7 * DAY_MS;
/** With more events than rows, each page of them is held this long before the next takes its place. */
const PAGE_HOLD_MS = 10_000;
const DEFAULT_ZONE = "America/Los_Angeles";

// These four must match Events.module.css: the row count is worked out from them, so no row is ever cut off.
const ROW_MIN_PX = 72;
const ROW_MAX_PX = 92;
const RULE_PX = 1;
const HEADER_PX = 32;

/** What a parent needs to decide whether the block earns its space. */
export type EventsState = {
  /** "loading" until the first answer, then the API's status. */
  status: EventsResponse["status"];
  /** Events in the week ahead that have not ended, i.e. how many rows there are to show (a page at a time if the height allows fewer). */
  count: number;
};

type Props = {
  /** Mono label above the list, shown only when it costs no row. null: never. */
  label?: string | null;
  /** Upper limit on rows; the height decides below that. */
  maxRows?: number;
  /** A fixed list instead of polling /api/events (previews, tests). */
  events?: CalendarEvent[];
  /** Called when the status or the number of events changes, so a parent can hide the block while it is empty. */
  onState?: (state: EventsState) => void;
  /**
   * For a parent that hides the block while there is nothing to list: no note and no box, and when the
   * last event ends its row stays where it was, so the block can be faded out rather than blanked.
   */
  quietWhenEmpty?: boolean;
  /** false: never page. Only the rows that fit are shown, soonest first, and the rest wait their turn off screen. */
  rotate?: boolean;
};

type Formats = {
  dayNumber: (ms: number) => number;
  time: (ms: number) => string;
  weekday: (day: number) => string;
  date: (day: number) => string;
};

/** Everything is formatted in the calendar's zone, never the browser's. */
function formatsFor(zone: string): Formats {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  // Day numbers are formatted from UTC midnight of that day, so these two are zone-free.
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
  return {
    dayNumber: (ms) => {
      const found: Record<string, number> = {};
      for (const part of parts.formatToParts(new Date(ms))) found[part.type] = Number(part.value);
      return Math.round(Date.UTC(found.year, found.month - 1, found.day) / DAY_MS);
    },
    // Newer ICU puts a narrow no-break space before AM/PM, which DM Mono has no glyph for.
    time: (ms) => clock.format(new Date(ms)).replace(/\s+/g, " "),
    weekday: (day) => weekday.format(new Date(day * DAY_MS)),
    date: (day) => date.format(new Date(day * DAY_MS)),
  };
}

function safeZone(zone: string | undefined): string {
  if (!zone) return DEFAULT_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_ZONE;
  }
}

const dayOfKey = (key: string | null): number | null => {
  const match = key ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key) : null;
  return match ? Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / DAY_MS) : null;
};

function dayLabel(day: number, today: number, formats: Formats): string {
  const ahead = day - today;
  if (ahead === 0) return "Today";
  if (ahead === 1) return "Tomorrow";
  if (ahead >= 2 && ahead <= 6) return formats.weekday(day);
  return formats.date(day);
}

type When = { live: boolean; day: string; detail: string };

function describe(event: CalendarEvent, now: number, formats: Formats): When {
  const today = formats.dayNumber(now);
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (event.allDay) {
    const first = dayOfKey(event.startDate) ?? formats.dayNumber(start);
    const last = Math.max(first, dayOfKey(event.endDate) ?? first);
    const from = Math.max(first, today);
    return { live: false, day: dayLabel(from, today, formats), detail: last > from ? `Through ${dayLabel(last, today, formats)}` : "All day" };
  }
  if (start <= now) {
    const endDay = formats.dayNumber(end);
    // "Until 1:00 AM" needs no day; an end further off does.
    const sameNight = endDay === today || end - now < 12 * 3_600_000;
    return { live: true, day: "Now", detail: `Until ${sameNight ? "" : `${dayLabel(endDay, today, formats)} `}${formats.time(end)}` };
  }
  return { live: false, day: dayLabel(formats.dayNumber(start), today, formats), detail: formats.time(start) };
}

/**
 * The week ahead from the club calendar. Fills its container (give it a width and a height) and shows
 * as many whole rows as fit: nothing is ever cut off or scrolled. More events than rows are shown a
 * page at a time, in turn (unless `rotate` is false).
 */
export function Events({ label = "Upcoming", maxRows = 6, events: fixed, onState, quietWhenEmpty = false, rotate = true }: Props) {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [height, setHeight] = useState(0);
  const root = useRef<HTMLElement>(null);
  // Server clock minus this page's clock, so a screen with a wrong clock still flips events on time.
  const skew = useRef(0);

  useEffect(() => {
    if (fixed) return;
    let alive = true;
    let timer: number | undefined;
    let request: AbortController | null = null;

    const poll = async () => {
      request = new AbortController();
      const giveUp = window.setTimeout(() => request?.abort(), REQUEST_TIMEOUT_MS);
      let settled = false;
      try {
        const sent = Date.now();
        const response = await fetch("/api/events", { cache: "no-store", signal: request.signal });
        if (!response.ok) throw new Error("Events request failed");
        const next = (await response.json()) as EventsResponse;
        if (!alive) return;
        const server = Date.parse(next.now);
        if (Number.isFinite(server)) skew.current = server - (sent + Date.now()) / 2;
        settled = next.status === "ok";
        setData(next);
        setNow(Date.now() + skew.current);
      } catch {
        // Keep the last list: its times are absolute, so events still start, end and drop off on this page's clock.
      } finally {
        window.clearTimeout(giveUp);
      }
      if (alive) timer = window.setTimeout(poll, settled ? POLL_MS : UNSETTLED_POLL_MS);
    };
    poll();

    return () => {
      alive = false;
      window.clearTimeout(timer);
      request?.abort();
    };
  }, [fixed]);

  const zone = useMemo(() => safeZone(data?.timeZone), [data?.timeZone]);
  const formats = useMemo(() => formatsFor(zone), [zone]);

  // Soonest first; anything that has ended, or starts more than a week out, is not there as of this render's `now`.
  const list = useMemo(() => {
    const source = fixed ?? data?.events ?? [];
    return source
      .filter((event) => Date.parse(event.start) < now + WEEK_AHEAD_MS && Date.parse(event.end) > now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [fixed, data, now]);

  const status: EventsResponse["status"] = fixed ? "ok" : data?.status ?? "loading";
  const count = list.length;
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });
  useEffect(() => {
    report.current?.({ status, count });
  }, [status, count]);

  // The last list that had anything in it: what a quiet block keeps showing while its parent fades it out.
  const [held, setHeld] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (list.length) setHeld(list);
  }, [list]);
  const shown = list.length || !quietWhenEmpty ? list : held;

  // Own clock: wake at the next start or end among the listed events, so a row turns to "Now" or leaves on time.
  useEffect(() => {
    let next = now + MAX_TICK_MS;
    for (const event of list) {
      for (const at of [Date.parse(event.start), Date.parse(event.end)]) if (at > now && at < next) next = at;
    }
    const timer = window.setTimeout(() => setNow(Date.now() + skew.current), Math.max(250, next - now + 50));
    return () => window.clearTimeout(timer);
  }, [now, list]);

  // Layout pixels of the stage, not screen pixels: the page's scale transform does not affect this.
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setHeight(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = Math.floor((height + RULE_PX) / (ROW_MIN_PX + RULE_PX));
  const rows = Math.min(fit, Math.max(1, maxRows), shown.length);
  const showLabel = label !== null && label !== "" && rows > 0 && HEADER_PX + rows * ROW_MIN_PX + (rows - 1) * RULE_PX <= height;
  const rowHeight = rows > 0 ? Math.min(ROW_MAX_PX, Math.floor((height - (showLabel ? HEADER_PX : 0) - (rows - 1) * RULE_PX) / rows)) : 0;

  // Pages are whole rows of one height; the last may be short, and leaves its space empty rather than stretch.
  const pages = rows > 0 && rotate ? Math.ceil(shown.length / rows) : 1;
  const [page, setPage] = useState(0);
  // An event ending or the box changing can leave fewer pages than the one being shown: back to the first.
  const current = page < pages ? page : 0;

  useEffect(() => {
    if (pages < 2) return;
    const hold = window.setInterval(() => setPage((shownPage) => (shownPage + 1) % pages), PAGE_HOLD_MS);
    return () => window.clearInterval(hold);
  }, [pages]);

  if (!shown.length) {
    const loading = !fixed && (data === null || data.status === "loading");
    const note = loading || quietWhenEmpty ? "" : !fixed && data?.status === "error" ? "Calendar not connected" : "No upcoming events";
    return (
      <section ref={root} className={`${styles.events} ${quietWhenEmpty ? "" : styles.isEmpty}`} aria-label="Upcoming events">
        {note && <p className={styles.note}>{note}</p>}
      </section>
    );
  }

  return (
    <section ref={root} className={styles.events} aria-label="Upcoming events">
      {showLabel && <p className={styles.header}>{label}</p>}
      {/* Keyed by page, so each page fades in as it takes its turn. */}
      <ol key={current} className={styles.list}>
        {shown.slice(current * rows, (current + 1) * rows).map((event) => {
          const when = describe(event, now, formats);
          return (
            <li key={event.id} className={`${styles.row} ${when.live ? styles.isLive : ""}`} style={{ height: rowHeight }}>
              <div className={styles.meta}>
                <time className={styles.when} dateTime={event.allDay && event.startDate ? event.startDate : event.start}>
                  {when.live && <span className={styles.pip} aria-hidden="true" />}
                  <span className={styles.day}>{when.day}</span>
                  <span className={styles.detail}>{when.detail}</span>
                </time>
                {event.location && <span className={styles.place}>{event.location}</span>}
              </div>
              <p className={styles.title}>{event.title}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
