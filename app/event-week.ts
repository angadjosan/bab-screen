import type { CalendarEvent } from "../lib/events";

export const DAY_MS = 86_400_000;
export const WEEK_DAYS = 7;
const DEFAULT_ZONE = "America/Los_Angeles";

export type Formats = {
  dayNumber: (ms: number) => number;
  time: (ms: number) => string;
  shortWeekday: (day: number) => string;
  dayOfMonth: (day: number) => number;
};

/** Everything is placed and formatted in the calendar's zone, never the browser's. */
export function formatsFor(zone: string): Formats {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  // Day numbers are formatted from UTC midnight of that day, so these are zone-free.
  const shortWeekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
  const read = (ms: number) => {
    const found: Record<string, number> = {};
    for (const part of parts.formatToParts(new Date(ms))) found[part.type] = Number(part.value);
    return found;
  };
  return {
    dayNumber: (ms) => {
      const found = read(ms);
      return Math.round(Date.UTC(found.year, found.month - 1, found.day) / DAY_MS);
    },
    // "7 PM" rather than "7:00 PM"; newer ICU puts a narrow no-break space before AM/PM.
    time: (ms) => clock.format(new Date(ms)).replace(/:00(?=\s)/, "").replace(/\s+/g, " "),
    shortWeekday: (day) => shortWeekday.format(new Date(day * DAY_MS)),
    dayOfMonth: (day) => new Date(day * DAY_MS).getUTCDate(),
  };
}

export function safeZone(zone: string | undefined): string {
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

/** The first and last calendar day an event covers (inclusive), in the calendar's zone. */
export function eventDays(event: CalendarEvent, formats: Formats): { first: number; last: number } {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (event.allDay) {
    const first = dayOfKey(event.startDate) ?? formats.dayNumber(start);
    return { first, last: Math.max(first, dayOfKey(event.endDate) ?? first) };
  }
  // An event ending at midnight belongs to the day before.
  return { first: formats.dayNumber(start), last: Math.max(formats.dayNumber(start), formats.dayNumber(end - 1)) };
}

export const isLive = (event: CalendarEvent, now: number) => !event.allDay && Date.parse(event.start) <= now && Date.parse(event.end) > now;

/** A day of the week board: the timed events that start that day (or are under way on it, for today). */
export type DayColumn = { day: number; events: CalendarEvent[] };
/** An all-day or multi-day event as a bar across columns `from` to `to` (0 is today), in lane `row`. */
export type Lane = { event: CalendarEvent; from: number; to: number; row: number };

/** Whether an event is drawn as a bar across days rather than listed under one. */
export function isSpanning(event: CalendarEvent, formats: Formats): boolean {
  const { first, last } = eventDays(event, formats);
  return event.allDay || last > first;
}

export function weekColumns(events: readonly CalendarEvent[], now: number, formats: Formats): DayColumn[] {
  const today = formats.dayNumber(now);
  const columns: DayColumn[] = Array.from({ length: WEEK_DAYS }, (_, i) => ({ day: today + i, events: [] }));
  for (const event of events) {
    if (isSpanning(event, formats)) continue;
    const column = Math.max(eventDays(event, formats).first, today) - today;
    if (column < WEEK_DAYS) columns[column].events.push(event);
  }
  return columns;
}

/** Bars for the spanning events, each in the first lane where it overlaps nothing already placed. */
export function weekLanes(events: readonly CalendarEvent[], now: number, formats: Formats): Lane[] {
  const today = formats.dayNumber(now);
  const lanes: Lane[] = [];
  for (const event of events) {
    if (!isSpanning(event, formats)) continue;
    const { first, last } = eventDays(event, formats);
    const from = Math.max(first, today) - today;
    const to = Math.min(last - today, WEEK_DAYS - 1);
    if (to < from) continue;
    let row = 0;
    while (lanes.some((lane) => lane.row === row && lane.from <= to && from <= lane.to)) row += 1;
    lanes.push({ event, from, to, row });
  }
  return lanes;
}

/** An event's time on the board, where its column already gives the day: "7 PM", or "Until 9 PM" once it has begun. */
export function timeLabel(event: CalendarEvent, now: number, formats: Formats): string {
  if (isLive(event, now)) return `Until ${formats.time(Date.parse(event.end))}`;
  return event.allDay ? "All day" : formats.time(Date.parse(event.start));
}
