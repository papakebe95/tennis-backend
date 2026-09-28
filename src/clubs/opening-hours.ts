// ---------------------------------------------------------------------------
// Opening hours: parsing, validation and the windows a court is bookable in.
//
// Club.openingHours is stored as { mon: ["07:00-22:00"], …, sun: [] } (one or
// more "HH:mm-HH:mm" windows per day; empty = closed). Older rows used range
// keys ({ "mon-fri": "07:00-22:00", "sat-sun": "08:00-20:00" }) and are still
// read. A court may override its club with CourtAvailability rows. Times are
// UTC, like the rest of the booking system.
// ---------------------------------------------------------------------------

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface TimeWindow {
  opensAt: string;
  closesAt: string;
}

export type WeeklyHours = Record<Weekday, TimeWindow[]>;

/** When neither the court nor its club says otherwise. */
export const DEFAULT_WINDOW: TimeWindow = { opensAt: '08:00', closesAt: '22:00' };

const TIME = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export const isTime = (value: string) => TIME.test(value);

export const toMinutes = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

/** Monday = 0 … Sunday = 6, for a UTC date. */
export const weekdayIndex = (date: Date) => (date.getUTCDay() + 6) % 7;

/**
 * Throws a message key when windows are malformed, inverted or overlap.
 * Returns them sorted.
 */
export function validateWindows(windows: TimeWindow[]): TimeWindow[] {
  for (const w of windows) {
    if (!isTime(w.opensAt) || !isTime(w.closesAt)) throw new HoursError('invalidTime');
    if (toMinutes(w.opensAt) >= toMinutes(w.closesAt)) throw new HoursError('closesBeforeOpens');
  }
  const sorted = [...windows].sort((a, b) => toMinutes(a.opensAt) - toMinutes(b.opensAt));
  for (let i = 1; i < sorted.length; i++) {
    if (toMinutes(sorted[i].opensAt) < toMinutes(sorted[i - 1].closesAt)) throw new HoursError('overlap');
  }
  return sorted;
}

export class HoursError extends Error {
  constructor(readonly reason: 'invalidTime' | 'closesBeforeOpens' | 'overlap') {
    super(reason);
  }
}

const parseRange = (range: unknown): TimeWindow | null => {
  if (typeof range !== 'string') return null;
  const [opensAt, closesAt] = range.split('-').map((part) => part.trim());
  if (!opensAt || !closesAt || !isTime(opensAt) || !isTime(closesAt)) return null;
  return toMinutes(opensAt) < toMinutes(closesAt) ? { opensAt, closesAt } : null;
};

const parseDay = (value: unknown): TimeWindow[] => {
  const ranges = Array.isArray(value) ? value : value ? [value] : [];
  return ranges.map(parseRange).filter((w): w is TimeWindow => w !== null);
};

/** Stored hours (either format) → one entry per weekday; null when unset. */
export function parseOpeningHours(raw: unknown): WeeklyHours | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const week = Object.fromEntries(WEEKDAYS.map((day) => [day, [] as TimeWindow[]])) as WeeklyHours;
  let seen = false;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const [from, to = from] = key.toLowerCase().split('-') as [Weekday, Weekday?];
    const start = WEEKDAYS.indexOf(from);
    const end = WEEKDAYS.indexOf(to as Weekday);
    if (start === -1 || end === -1) continue;
    seen = true;
    for (let i = start; i <= end; i++) week[WEEKDAYS[i]] = parseDay(value);
  }
  return seen ? week : null;
}

/** Canonical stored form. */
export const toStoredHours = (week: WeeklyHours): Record<Weekday, string[]> =>
  Object.fromEntries(
    WEEKDAYS.map((day) => [day, week[day].map((w) => `${w.opensAt}-${w.closesAt}`)]),
  ) as Record<Weekday, string[]>;

/**
 * The windows a court is open on `date`: its own rows for that weekday when
 * it has any rows at all, else its club's hours, else the default.
 */
export function windowsFor(
  date: Date,
  courtWindows: { weekday: number; opensAt: string; closesAt: string }[],
  clubHours: WeeklyHours | null,
): TimeWindow[] {
  const weekday = weekdayIndex(date);
  if (courtWindows.length) {
    return courtWindows
      .filter((w) => w.weekday === weekday)
      .map(({ opensAt, closesAt }) => ({ opensAt, closesAt }))
      .sort((a, b) => toMinutes(a.opensAt) - toMinutes(b.opensAt));
  }
  if (clubHours) return clubHours[WEEKDAYS[weekday]];
  return [DEFAULT_WINDOW];
}

/** One-hour slots [start, end) fitting inside the windows of `day` (UTC). */
export function hourlySlots(day: Date, windows: TimeWindow[]): { start: Date; end: Date }[] {
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const slots: { start: Date; end: Date }[] = [];
  for (const w of windows) {
    for (let m = toMinutes(w.opensAt); m + 60 <= toMinutes(w.closesAt); m += 60) {
      slots.push({ start: new Date(midnight + m * 60_000), end: new Date(midnight + (m + 60) * 60_000) });
    }
  }
  return slots;
}

/** True when [start, end) lies inside a single window of its (UTC) day. */
export function fitsWindows(start: Date, end: Date, windows: TimeWindow[]): boolean {
  const midnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const from = (start.getTime() - midnight) / 60_000;
  const to = (end.getTime() - midnight) / 60_000;
  return windows.some((w) => from >= toMinutes(w.opensAt) && to <= toMinutes(w.closesAt));
}
