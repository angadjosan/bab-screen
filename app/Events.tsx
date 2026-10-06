"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CalendarEvent, EventsResponse } from "../lib/events";
import { buildWeek, DAY_MS, formatsFor, groupByDay, isLive, safeZone, timeLabel, WEEK_DAYS, whenLabel, type Formats, type Week } from "./event-week";
import styles from "./Events.module.css";

const POLL_MS = 5 * 60_000;
/** While the server is still doing its first download, or has nothing, ask again sooner. */
const UNSETTLED_POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 8_000;
/** The clock is re-read at the next start or end, and at least this often (midnight, a machine waking from sleep). */
const MAX_TICK_MS = 30_000;
/** Only the week ahead is shown: an event has to start within this long from now (or be under way). */
const WEEK_AHEAD_MS = WEEK_DAYS * DAY_MS;

const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

/** What a parent needs to decide whether the block earns its space. */
export type EventsState = {
  /** "loading" until the first answer, then the API's status. */
  status: EventsResponse["status"];
  /** Events in the week ahead that have not ended. */
  count: number;
};

type Props = {
  /**
   * compact: the next event in words over the week drawn as seven tracks (the side column's short slot).
   * full: the week's tracks over every event, grouped by day, as many as fit (focus mode's whole column).
   */
  layout?: "compact" | "full";
  /** A fixed list instead of polling /api/events (previews, tests). */
  events?: CalendarEvent[];
  /** Called when the status or the number of events changes, so a parent can hide the block while it is empty. */
  onState?: (state: EventsState) => void;
  /**
   * For a parent that hides the block while there is nothing to list: no note and no box, and when the
   * last event ends it stays drawn as it was, so the block can be faded out rather than blanked.
   */
  quietWhenEmpty?: boolean;
};

/** /api/events, polled, with the server's clock: a screen with a wrong clock still flips events on time. */
function useCalendar(fixed: CalendarEvent[] | undefined) {
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

  // Soonest first; anything that has ended, or starts more than a week out, is not there as of this render's `now`.
  const list = useMemo(() => {
    const source = fixed ?? data?.events ?? [];
    return source
      .filter((event) => Date.parse(event.start) < now + WEEK_AHEAD_MS && Date.parse(event.end) > now)
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }, [fixed, data, now]);

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

/**
 * The week as seven tracks, today first. Each track runs down through the hours the week's events fall in, so a
 * late meeting sits low and an early one high; the next event is lit, one under way is gold, and the part of
 * today that has passed is shaded. All-day and multi-day events are bars across the top of the days they cover.
 */
function WeekStrip({ week, formats, today }: { week: Week; formats: Formats; today: number }) {
  return (
    <div className={styles.week} style={{ "--rule-every": `${week.ruleEvery * 100}%` } as CSSProperties} aria-hidden="true">
      {week.days.map(({ day, busy }, column) => (
        <div key={day} className={cx(styles.dayHead, busy && styles.busy, day === today && styles.today)} style={{ gridColumn: column + 1 }}>
          <span className={styles.weekday}>{formats.shortWeekday(day)}</span>
          <span className={styles.date}>{formats.dayOfMonth(day)}</span>
        </div>
      ))}
      {week.spans.length > 0 && (
        <div className={styles.lane}>
          {week.spans.map((span) => (
            <span key={span.id} className={cx(styles.span, span.next && styles.next)} style={{ gridColumn: `${span.from + 1} / ${span.to + 2}` }} />
          ))}
        </div>
      )}
      {week.days.map(({ day, blocks }, column) => (
        <div key={day} className={styles.track} style={{ gridColumn: column + 1 }}>
          {column === 0 && <span className={styles.past} style={{ height: `${week.nowAt * 100}%` }} />}
          {blocks.map((block) => (
            <span
              key={block.id}
              className={cx(styles.block, block.next && styles.next, block.live && styles.live)}
              style={{ top: `${block.top * 100}%`, height: `${block.height * 100}%` }}
            />
          ))}
          {column === 0 && <span className={styles.now} style={{ top: `${week.nowAt * 100}%` }} />}
        </div>
      ))}
    </div>
  );
}

/** The next event in words: when, where and what. */
function NextUp({ event, now, formats }: { event: CalendarEvent; now: number; formats: Formats }) {
  const live = isLive(event, now);
  return (
    <div className={cx(styles.nextUp, live && styles.isLive)}>
      <p className={styles.nextWhen}>
        <time dateTime={event.start}>{live && <span className={styles.pip} aria-hidden="true" />}{whenLabel(event, now, formats)}</time>
        {event.location && <span className={styles.place}>{event.location}</span>}
      </p>
      <p className={styles.nextTitle}>{event.title}</p>
    </div>
  );
}

/** How many events, in order, fit whole in the agenda's box. */
function useFitCount(box: React.RefObject<HTMLElement | null>, total: number) {
  const [fit, setFit] = useState(total);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => {
      const rows = [...element.querySelectorAll<HTMLElement>("[data-event]")];
      const room = element.clientHeight;
      const fitting = rows.findIndex((row) => row.offsetTop + row.offsetHeight > room);
      setFit(fitting < 0 ? rows.length : fitting);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [box, total]);
  return fit;
}

/**
 * The week's events under their day: the date once, large, beside every event that day. Events that do not fit
 * whole are hidden rather than cut, and so is a day whose events are all hidden.
 */
function Agenda({ events, now, formats }: { events: readonly CalendarEvent[]; now: number; formats: Formats }) {
  const box = useRef<HTMLOListElement>(null);
  const fit = useFitCount(box, events.length);
  const today = formats.dayNumber(now);
  let index = 0;
  return (
    <ol ref={box} className={styles.agenda}>
      {groupByDay(events, now, formats).map((group) => {
        const firstIndex = index;
        index += group.events.length;
        return (
          <li key={group.day} className={styles.dayGroup} style={firstIndex >= fit ? { visibility: "hidden" } : undefined}>
            <p className={styles.dayMark}>
              <span className={styles.dayNumber}>{formats.dayOfMonth(group.day)}</span>
              <span className={styles.dayName}>{group.day === today ? "Today" : formats.shortWeekday(group.day)}</span>
            </p>
            <ol className={styles.dayEvents}>
              {group.events.map((event, i) => {
                const live = isLive(event, now);
                return (
                  <li key={event.id} data-event className={cx(styles.item, live && styles.isLive)} style={firstIndex + i >= fit ? { visibility: "hidden" } : undefined}>
                    <time className={styles.itemTime} dateTime={event.start}>
                      {live && <span className={styles.pip} aria-hidden="true" />}
                      {timeLabel(event, now, formats)}
                    </time>
                    <div className={styles.itemBody}>
                      <p className={styles.itemTitle}>{event.title}</p>
                      {event.location && <p className={styles.itemPlace}>{event.location}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          </li>
        );
      })}
    </ol>
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

/**
 * The week ahead from the club calendar, drawn as a week of tracks (see WeekStrip) with the events in words beside
 * it: the next one in the compact layout, all that fit in the full one. Fills its container.
 */
export function Events({ layout = "compact", events: fixed, onState, quietWhenEmpty = false }: Props) {
  const { status, list, now, formats } = useCalendar(fixed);
  useReport(onState, { status, count: list.length });
  const shown = useHeldList(list, quietWhenEmpty);
  const next = pickNext(shown, now);
  const week = useMemo(() => buildWeek(shown, now, next?.id ?? null, formats), [shown, now, next, formats]);

  if (!next) {
    const note = emptyNote(status, fixed !== undefined, quietWhenEmpty);
    return (
      <section className={cx(styles.events, !quietWhenEmpty && styles.isEmpty)} aria-label="Upcoming events">
        {note && <p className={styles.note}>{note}</p>}
      </section>
    );
  }

  const strip = <WeekStrip week={week} formats={formats} today={formats.dayNumber(now)} />;
  const full = layout === "full";
  return (
    <section className={cx(styles.events, full ? styles.full : styles.compact)} aria-label="Upcoming events" style={{ "--days": WEEK_DAYS } as CSSProperties}>
      {full ? <>{strip}<Agenda events={shown} now={now} formats={formats} /></> : <><NextUp event={next} now={now} formats={formats} />{strip}</>}
    </section>
  );
}
