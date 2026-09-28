// Snooze times. A snooze is stored as an instant (UTC ms) with the IANA time
// zone it was chosen in, so it does not move when the owner opens the page
// on another device. A time given as a wall clock ("09:00", "завтра",
// "2026-09-29T09:00") is read in that zone; across a daylight-saving jump
// the clock time that does not exist moves forward and a repeated one takes
// its first occurrence.

export const DEFAULT_MORNING = { hour: 9, minute: 0 };

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `tz` at instant `at`. */
export function wallClock(at: number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** local − UTC in `tz` at instant `at`, in ms. */
function offsetAt(at: number, tz: string): number {
  const wall = wallClock(at, tz);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return asUtc - Math.floor(at / 1000) * 1000;
}

/** The instant a wall-clock time in `tz` names. */
export function zonedToInstant(wall: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const DAY = 86_400_000;
  // The zone's offset a day before and a day after: equal, except around a daylight-saving jump.
  const before = naive - offsetAt(naive - DAY, tz);
  const after = naive - offsetAt(naive + DAY, tz);
  const names = (at: number) => {
    const clock = wallClock(at, tz);
    return clock.year === wall.year && clock.month === wall.month && clock.day === wall.day && clock.hour === wall.hour && clock.minute === wall.minute;
  };
  const valid = [before, after].filter(names);
  // A repeated hour: its first occurrence. A skipped one: read with the offset before the jump, it lands after it.
  return valid.length > 0 ? Math.min(...valid) : before;
}

/** The day after `at` in `tz`, at `time`. */
export function tomorrowAt(at: number, tz: string, time = DEFAULT_MORNING): number {
  const today = wallClock(at, tz);
  const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
  return zonedToInstant({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), ...time }, tz);
}

/**
 * When a snooze given as text ends: an ISO time with an offset, a wall clock
 * in `tz` ("2026-09-29T09:00", "2026-09-29 09:00"), a time of day (today if
 * still ahead, else tomorrow) or "tomorrow"/"завтра" (9:00). Null if unreadable.
 */
export function parseUntil(text: string, now: number, tz: string): number | null {
  const value = text.trim().toLowerCase();
  if (value === "tomorrow" || value === "завтра") return tomorrowAt(now, tz);
  if (/(z|[+-]\d\d:?\d\d)$/.test(value) && /^\d{4}-\d\d-\d\dt/.test(value)) {
    const parsed = Date.parse(text.trim());
    return Number.isNaN(parsed) ? null : parsed;
  }
  const full = /^(\d{4})-(\d\d)-(\d\d)[t ](\d{1,2}):(\d\d)$/.exec(value);
  if (full) {
    const [, year, month, day, hour, minute] = full.map(Number) as [number, number, number, number, number, number];
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    return zonedToInstant({ year, month, day, hour, minute }, tz);
  }
  const clock = /^(\d{1,2}):(\d\d)$/.exec(value);
  if (clock) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    const today = wallClock(now, tz);
    const at = zonedToInstant({ year: today.year, month: today.month, day: today.day, hour, minute }, tz);
    return at > now ? at : tomorrowAt(now, tz, { hour, minute });
  }
  return null;
}

/** "Tue 29 Sept, 09:00 (Europe/Moscow)". */
export function describeUntil(at: number, tz: string | null): string {
  const zone = tz !== null && isTimeZone(tz) ? tz : undefined;
  const text = new Intl.DateTimeFormat("en-GB", {
    ...(zone ? { timeZone: zone } : {}),
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
  return zone ? `${text} (${zone})` : text;
}
