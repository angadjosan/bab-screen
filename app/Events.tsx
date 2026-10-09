"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { CalendarEvent, EventsResponse } from "../lib/events";
import { DAY_MS, formatsFor, isLive, safeZone, timeLabel, WEEK_DAYS, weekColumns, weekLanes, type DayColumn, type Formats, type Lane } from "./event-week";
import styles from "./Events.module.css";

const POLL_MS = 5 * 60_000;
/** While the server is still doing its first download, or has nothing, ask again sooner. */
const UNSETTLED_POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** The clock is re-read at the next start or end, and at least this often (midnight, a machine waking from sleep). */
const MAX_TICK_MS = 30_000;

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** What a parent needs to decide whether the block earns its space. */
export type EventsState = {
  /** "loading" until the first answer, then the API's status. */
  status: EventsResponse["status"];
  /** Events on the board that have not ended. */
  count: number;
};

type Props = {
  /** A fixed list instead of polling /api/events (previews, tests). */
  events?: CalendarEvent[];
  /** Called when the status or the number of events changes, so a parent can hide the block while it is empty. */
  onState?: (state: EventsState) => void;
  /**
   * For a parent that hides the block while there is nothing to list: no note and no box, and when the
   * last event ends it stays drawn as it was, so the block can be faded out rather than blanked.
   */
  quietWhenEmpty?: boolean;
  /** Columns on the board, today first; only events starting within that many days are listed. A week by default. */
  days?: number;
};

/** /api/events, polled, with the server's clock: a screen with a wrong clock still flips events on time. */
function useCalendar(fixed: CalendarEvent[] | undefined, days: number) {
  const [data, setData] = useState<EventsResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Server clock minus this page's clock.
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

  const formats = useMemo(() => formatsFor(safeZone(data?.timeZone)), [data?.timeZone]);

  // Soonest first; anything that has ended, or starts past the last column, is not there as of this render's `now`.
  const list = useMemo(() => {
    const source = fixed ?? data?.events ?? [];
    return source
      .filter((event) => Date.parse(event.start) < now + days * DAY_MS && Date.parse(event.end) > now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [fixed, data, now, days]);

  // Own clock: wake at the next start or end among the events, so one turns live or leaves on time.
  useEffect(() => {
    let next = now + MAX_TICK_MS;
    for (const event of list) {
      for (const at of [Date.parse(event.start), Date.parse(event.end)]) if (at > now && at < next) next = at;
    }
    const timer = window.setTimeout(() => setNow(Date.now() + skew.current), Math.max(250, next - now + 50));
    return () => window.clearTimeout(timer);
  }, [now, list]);

  const status: EventsResponse["status"] = fixed ? "ok" : data?.status ?? "loading";
  return { status, list, now, formats };
}

/** The live event if one is under way, otherwise the soonest timed event, otherwise the soonest of any kind. */
function pickNext(list: readonly CalendarEvent[], now: number): CalendarEvent | null {
  return list.find((event) => isLive(event, now)) ?? list.find((event) => !event.allDay) ?? list[0] ?? null;
}

/** The height kept free at the foot of a day for its "+2 more" line. Must match .more in Events.module.css. */
const MORE_LINE_PX = 30;

/**
 * How many of each day's events fit whole in its column, by day. Every event stays in the markup (the ones that
 * do not fit are hidden), so measuring never changes what is measured.
 */
function useDayFit(board: RefObject<HTMLDivElement | null>, layoutKey: string) {
  const [fit, setFit] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const element = board.current;
    if (!element) return;
    const measure = () => {
      const next: Record<string, number> = {};
      for (const column of element.querySelectorAll<HTMLElement>("[data-day]")) {
        const rows = [...column.querySelectorAll<HTMLElement>("[data-event]")];
        const bottom = (row: HTMLElement) => row.offsetTop + row.offsetHeight;
        const room = column.clientHeight;
        const all = rows.every((row) => bottom(row) <= room);
        next[column.dataset.day ?? ""] = all ? rows.length : rows.filter((row) => bottom(row) <= room - MORE_LINE_PX).length;
      }
      setFit((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [board, layoutKey]);
  return fit;
}

type BoardProps = { now: number; formats: Formats; nextId: string | null };

function EventItem({ event, now, formats, nextId, hidden }: BoardProps & { event: CalendarEvent; hidden: boolean }) {
  const live = isLive(event, now);
  return (
    <li data-event className={cx(styles.item, live && styles.live, event.id === nextId && styles.next)} style={hidden ? { visibility: "hidden" } : undefined}>
      <p className={styles.itemMeta}>
        <time className={styles.itemTime} dateTime={event.start}>{timeLabel(event, now, formats)}</time>
        {event.location && <span className={styles.itemPlace}>{event.location}</span>}
      </p>
      <p className={styles.itemTitle}>{event.title}</p>
    </li>
  );
}

function DayEvents({ column, fit, ...board }: BoardProps & { column: DayColumn; fit: number | undefined }) {
  const shown = fit ?? column.events.length;
  const more = column.events.length - shown;
  return (
    <div data-day={column.day} className={styles.dayEvents}>
      <ol className={styles.items}>
        {column.events.map((event, i) => <EventItem key={event.id} event={event} hidden={i >= shown} {...board} />)}
      </ol>
      {more > 0 && <p className={styles.more}>+{more} more</p>}
    </div>
  );
}

function LaneBar({ lane, now, formats, nextId }: BoardProps & { lane: Lane }) {
  const { event } = lane;
  return (
    <p className={cx(styles.lane, event.id === nextId && styles.next)} style={{ gridColumn: `${lane.from + 1} / ${lane.to + 2}`, gridRow: lane.row + 1 }}>
      <span className={styles.laneTitle}>{event.title}</span>
      {!event.allDay && <time className={styles.laneTime} dateTime={event.start}>{timeLabel(event, now, formats)}</time>}
    </p>
  );
}

/**
 * The week as a wall calendar: a column a day from today, each headed by its date and listing that day's events
 * with their time, place and title. Events across several days are bars over the columns they cover. A day with
 * more events than fit says how many more.
 */
function WeekBoard({ events, now, formats, days }: { events: readonly CalendarEvent[]; now: number; formats: Formats; days: number }) {
  const board = useRef<HTMLDivElement>(null);
  const today = formats.dayNumber(now);
  const columns = weekColumns(events, now, formats, days);
  const lanes = weekLanes(events, now, formats, days);
  const shared = { now, formats, nextId: pickNext(events, now)?.id ?? null };
  const fit = useDayFit(board, events.map((event) => event.id).join() + lanes.length);
  return (
    <div ref={board} className={styles.board} style={{ "--days": days } as CSSProperties}>
      {columns.map(({ day, events: dayEvents }, i) => (
        <div key={day} className={cx(styles.dayHead, day === today && styles.today, dayEvents.length === 0 && styles.quiet)} style={{ gridColumn: i + 1 }}>
          <span className={styles.date}>{formats.dayOfMonth(day)}</span>
          <span className={styles.weekday}>{day === today ? "Today" : formats.shortWeekday(day)}</span>
        </div>
      ))}
      {lanes.length > 0 && (
        <div className={styles.lanes}>{lanes.map((lane) => <LaneBar key={lane.event.id} lane={lane} {...shared} />)}</div>
      )}
      {columns.map((column, i) => (
        <div key={column.day} className={cx(styles.dayBody, column.day === today && styles.today)} style={{ gridColumn: i + 1 }}>
          <DayEvents column={column} fit={fit[String(column.day)]} {...shared} />
        </div>
      ))}
    </div>
  );
}

/** Calls the parent back when the status or the number of events changes. */
function useReport(onState: Props["onState"], state: EventsState) {
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });
  const { status, count } = state;
  useEffect(() => {
    report.current?.({ status, count });
  }, [status, count]);
}

/** The last list that had anything in it: what a quiet block keeps showing while its parent fades it out. */
function useHeldList(list: CalendarEvent[], quietWhenEmpty: boolean) {
  const [held, setHeld] = useState<CalendarEvent[]>([]);
  useEffect(() => {
    if (list.length) setHeld(list);
  }, [list]);
  return list.length || !quietWhenEmpty ? list : held;
}

function emptyNote(status: EventsResponse["status"], fixed: boolean, quietWhenEmpty: boolean) {
  if (quietWhenEmpty || (!fixed && status === "loading")) return "";
  return !fixed && status === "error" ? "Calendar not connected" : "No upcoming events";
}

/** The week ahead from the club calendar, as a wall calendar (see WeekBoard). Fills its container. */
export function Events({ events: fixed, onState, quietWhenEmpty = false, days = WEEK_DAYS }: Props) {
  const { status, list, now, formats } = useCalendar(fixed, days);
  useReport(onState, { status, count: list.length });
  const shown = useHeldList(list, quietWhenEmpty);
  if (!shown.length) {
    const note = emptyNote(status, fixed !== undefined, quietWhenEmpty);
    return (
      <section className={cx(styles.events, !quietWhenEmpty && styles.isEmpty)} aria-label="Upcoming events">
        {note && <p className={styles.note}>{note}</p>}
      </section>
    );
  }

  return (
    <section className={styles.events} aria-label="Upcoming events">
      <WeekBoard events={shown} now={now} formats={formats} days={days} />
    </section>
  );
}
