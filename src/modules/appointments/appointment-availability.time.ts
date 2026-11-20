import { isValidTimeZone } from "../branches/branch.schemas.js";

/**
 * Timezone primitives for appointment availability (Phase 18.2).
 *
 * The project intentionally has no date/time dependency: recurring schedules
 * store branch-local `TIME` values and `Intl.DateTimeFormat` resolves the IANA
 * zone. This module converts a local wall-clock date + time into a UTC instant
 * and back without ever using the server's own timezone.
 *
 * DST policy (same as the Phase 16 documentation):
 * - a local time that does not exist (spring forward) is rejected, so callers
 *   skip it;
 * - a local time that occurs twice (fall back) resolves to the first
 *   occurrence, i.e. the earlier UTC instant.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface ZonedDateParts extends DateParts {
  /** ISO calendar date in the target zone (`YYYY-MM-DD`). */
  readonly date: string;
  /** Minutes from local midnight. */
  readonly minutes: number;
}

export interface ZonedWallTime {
  /** NULL when the local time does not exist because of a DST jump. */
  readonly instant: Date | null;
  /** True when the local time occurred twice (fall back). */
  readonly ambiguous: boolean;
}

export function isIanaTimeZone(value: string): boolean {
  return isValidTimeZone(value);
}

/** Strict ISO calendar date validation (rejects 2026-02-30). */
export function normalizeIsoDate(value: string, field: string): string {
  const match = DATE_PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(`${field} must be an ISO date (YYYY-MM-DD)`);
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${field} must be a valid calendar date`);
  }

  return `${yearText}-${monthText}-${dayText}`;
}

export function parseIsoDate(date: string): DateParts {
  const [yearText, monthText, dayText] = date.split("-");
  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  };
}

/** ISO weekday: 1 = Monday ... 7 = Sunday, independent of server timezone. */
export function isoWeekday(date: string): number {
  const { year, month, day } = parseIsoDate(date);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function addDaysToIsoDate(date: string, days: number): string {
  const { year, month, day } = parseIsoDate(date);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** `HH:MM` / `HH:MM:SS` -> minutes from midnight. */
export function parseTimeToMinutes(value: string): number {
  const match = TIME_PATTERN.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid time value "${value}"; expected HH:MM or HH:MM:SS`);
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

/** Minutes from midnight -> zero-padded `HH:MM` (24-hour). */
export function formatMinutesAsTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function zonedParts(instant: Date, timeZone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);

  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Calendar date and wall-clock minutes of an instant in the target zone. */
export function getZonedDateParts(instant: Date, timeZone: string): ZonedDateParts {
  const parts = zonedParts(instant, timeZone);
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    date: `${parts.year}-${month}-${day}`,
    minutes: parts.hour * 60 + parts.minute,
  };
}

/** Zone offset in milliseconds at an instant (local wall clock - UTC). */
function offsetAt(instantMs: number, timeZone: string): number {
  const wholeSecond = Math.floor(instantMs / 1000) * 1000;
  const parts = zonedParts(new Date(wholeSecond), timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  return asUtc - wholeSecond;
}

/**
 * Converts a branch-local calendar date + minutes from midnight to an instant.
 *
 * Candidate offsets are sampled a day either side of the naive UTC guess, so
 * both sides of a DST transition are considered even when the transition falls
 * exactly on the requested local time. Candidates are validated by formatting
 * the instant back in the zone; this rejects non-existent local times and finds
 * both occurrences of an ambiguous one.
 */
export function zonedWallTimeToInstant(
  date: string,
  minutes: number,
  timeZone: string,
): ZonedWallTime {
  const { year, month, day } = parseIsoDate(date);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute);

  const offsets = new Set<number>();
  for (const delta of [-24, 0, 24]) {
    offsets.add(offsetAt(utcGuess + delta * 60 * 60 * 1000, timeZone));
  }

  const candidates = [...offsets]
    .map((offset) => utcGuess - offset)
    .filter((candidate) => {
      const parts = zonedParts(new Date(candidate), timeZone);
      return (
        parts.year === year &&
        parts.month === month &&
        parts.day === day &&
        parts.hour === hour &&
        parts.minute === minute
      );
    })
    .sort((left, right) => left - right);

  const unique = [...new Set(candidates)];

  if (unique.length === 0) {
    return { instant: null, ambiguous: false };
  }

  return {
    instant: new Date(unique[0]!),
    ambiguous: unique.length > 1,
  };
}

/** Today's calendar date in the branch zone. */
export function todayInZone(timeZone: string): string {
  return getZonedDateParts(new Date(), timeZone).date;
}
