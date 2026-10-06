import type { CalendarEvent } from "../lib/events";

export const DAY_MS = 86_400_000;
export const WEEK_DAYS = 7;
const DEFAULT_ZONE = "America/Los_Angeles";
/** The stretch of each day the week strip draws when there are no timed events to fit it to: 8 AM to midnight. */
const DEFAULT_WINDOW: TrackWindow = { start: 8 * 60, end: 24 * 60 };
const DAY_MINUTES = 24 * 60;
/** The window starts and ends on these steps, which are also where the track's faint hour rules fall. */
const RULE_MINUTES = 2 * 60;
const MIN_WINDOW_MINUTES = 6 * 60;
/** The shortest block the strip draws, as a fraction of the day, so a 15-minute event is still a visible mark. */
const MIN_BLOCK = 0.05;

export type Formats = {
  dayNumber: (ms: number) => number;
  minuteOfDay: (ms: number) => number;
  time: (ms: number) => string;
  weekday: (day: number) => string;
  shortWeekday: (day: number) => string;
  dayOfMonth: (day: number) => number;
};

/** Everything is placed and formatted in the calendar's zone, never the browser's. */
export function formatsFor(zone: string): Formats {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const clock = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" });
  // Day numbers are formatted from UTC midnight of that day, so these are zone-free.
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" });
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
    minuteOfDay: (ms) => {
      const found = read(ms);
      return (found.hour % 24) * 60 + found.minute;
    },
    // "7 PM" rather than "7:00 PM"; newer ICU puts a narrow no-break space before AM/PM.
    time: (ms) => clock.format(new Date(ms)).replace(/:00(?=\s)/, "").replace(/\s+/g, " "),
    weekday: (day) => weekday.format(new Date(day * DAY_MS)),
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

export function dayName(day: number, today: number, formats: Formats): string {
  if (day === today) return "Today";
  if (day === today + 1) return "Tomorrow";
  return formats.weekday(day);
}

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

/** The minutes of the day a track runs between; anything earlier or later sits at an edge. */
export type TrackWindow = { start: number; end: number };

/** Where a minute of the day falls on a track, from 0 (top) to 1 (bottom). */
export function trackPosition(minute: number, window: TrackWindow): number {
  return Math.min(1, Math.max(0, (minute - window.start) / (window.end - window.start)));
}

/** The minutes of the day an event's own day covers: a timed event that runs past midnight takes the rest of the day. */
function minuteRange(event: CalendarEvent, formats: Formats): TrackWindow {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const sameDay = formats.dayNumber(start) === formats.dayNumber(end - 1);
  return { start: formats.minuteOfDay(start), end: sameDay ? formats.minuteOfDay(end - 1) + 1 : DAY_MINUTES };
}

/**
 * The hours the week's timed events fall in, widened to whole two-hour steps and to six hours at least. Club
 * events are mostly in the evening, and on an 8 AM to midnight track they would all bunch at the bottom.
 */
export function trackWindow(events: readonly CalendarEvent[], formats: Formats): TrackWindow {
  const ranges = events.filter((event) => !event.allDay).map((event) => minuteRange(event, formats));
  if (!ranges.length) return DEFAULT_WINDOW;
  const end = Math.min(DAY_MINUTES, Math.ceil(Math.max(...ranges.map((r) => r.end)) / RULE_MINUTES) * RULE_MINUTES);
  const earliest = Math.min(...ranges.map((r) => r.start), end - MIN_WINDOW_MINUTES);
  return { start: Math.max(0, Math.floor(earliest / RULE_MINUTES) * RULE_MINUTES), end };
}

export type Block = { id: string; top: number; height: number; live: boolean; next: boolean };
export type Span = { id: string; from: number; to: number; next: boolean };
export type WeekDay = { day: number; blocks: Block[]; busy: boolean };
/** `ruleEvery` is the gap between the track's hour rules, as a fraction of its height. */
export type Week = { days: WeekDay[]; spans: Span[]; nowAt: number; ruleEvery: number };

/** One timed event's part of one day, as a block on that day's track. */
function blockFor(event: CalendarEvent, day: number, window: TrackWindow, formats: Formats, flags: { live: boolean; next: boolean }): Block {
  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  const fromMinute = formats.dayNumber(start) === day ? formats.minuteOfDay(start) : 0;
  const toMinute = formats.dayNumber(end - 1) === day ? formats.minuteOfDay(end - 1) + 1 : DAY_MINUTES;
  const top = Math.min(trackPosition(fromMinute, window), 1 - MIN_BLOCK);
  const height = Math.max(MIN_BLOCK, trackPosition(toMinute, window) - top);
  return { id: event.id, top, height, ...flags };
}

/**
 * The seven days from today as tracks over the hours the week's events fall in: timed events become blocks placed by time of day, all-day and
 * multi-day events become spans across the days they cover. `nowAt` is where the present sits on today's track.
 */
export function buildWeek(events: readonly CalendarEvent[], now: number, nextId: string | null, formats: Formats): Week {
  const today = formats.dayNumber(now);
  const window = trackWindow(events, formats);
  const days: WeekDay[] = Array.from({ length: WEEK_DAYS }, (_, i) => ({ day: today + i, blocks: [], busy: false }));
  const spans: Span[] = [];
  for (const event of events) {
    const { first, last } = eventDays(event, formats);
    const from = Math.max(first, today) - today;
    const to = Math.min(last, today + WEEK_DAYS - 1) - today;
    if (to < from) continue;
    const next = event.id === nextId;
    for (let i = from; i <= to; i += 1) days[i].busy = true;
    if (event.allDay) {
      spans.push({ id: event.id, from, to, next });
      continue;
    }
    const live = isLive(event, now);
    for (let i = from; i <= to; i += 1) days[i].blocks.push(blockFor(event, today + i, window, formats, { live, next }));
  }
  return { days, spans, nowAt: trackPosition(formats.minuteOfDay(now), window), ruleEvery: RULE_MINUTES / (window.end - window.start) };
}

/** When an event is, in words: "Now, until 9 PM", "Tomorrow, 7 PM", "Friday, all day" or "Friday to Sunday". */
export function whenLabel(event: CalendarEvent, now: number, formats: Formats): string {
  const today = formats.dayNumber(now);
  const { first, last } = eventDays(event, formats);
  const day = dayName(Math.max(first, today), today, formats);
  if (event.allDay) return last > Math.max(first, today) ? `${day} to ${dayName(last, today, formats)}` : `${day}, all day`;
  if (isLive(event, now)) return `Now, until ${formats.time(Date.parse(event.end))}`;
  return `${day}, ${formats.time(Date.parse(event.start))}`;
}

/** The time column of the agenda, where the day is already given by the group. */
export function timeLabel(event: CalendarEvent, now: number, formats: Formats): string {
  if (isLive(event, now)) return "Now";
  return event.allDay ? "All day" : formats.time(Date.parse(event.start));
}

/** The week's events grouped under the day each one starts on (today for one already under way). */
export function groupByDay(events: readonly CalendarEvent[], now: number, formats: Formats): { day: number; events: CalendarEvent[] }[] {
  const today = formats.dayNumber(now);
  const groups: { day: number; events: CalendarEvent[] }[] = [];
  for (const event of events) {
    const day = Math.max(eventDays(event, formats).first, today);
    const group = groups.find((g) => g.day === day);
    if (group) group.events.push(event);
    else groups.push({ day, events: [event] });
  }
  return groups.sort((a, b) => a.day - b.day);
}
