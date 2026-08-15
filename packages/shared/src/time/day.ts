/**
 * Calendar days, and why a day divider is not a `Date`.
 *
 * A conversation is broken up by day: "Today", "Yesterday", "Friday 6 March".
 * Which day a message belongs under is a question about the **reader's**
 * calendar, not the sender's and not the server's. A message sent at 23:40 in
 * Madrid was sent at 19:40 the same day in Santiago and at 08:40 the *next* day
 * in Auckland, and each of those readers should see it filed under their own
 * date. Compute the divider from an instant in the process's zone and the
 * conversation acquires a "Yesterday" that is only true for whoever deployed it.
 *
 * So a divider's type is `CalendarDay`: the string `YYYY-MM-DD`, no zone, no
 * clock, no arithmetic that can shift it. It is derived from the message's
 * instant and the reader's `timeZone` by `today()`/`fromUtcDate()`, and compared
 * as a string thereafter.
 *
 * The dangerous moment in the round trip is `Date` -- `new Date('2026-03-01')`
 * printed in `America/Santiago` is 28 February -- so every conversion here uses
 * the UTC accessors and nothing else. `getDate()` and friends do not appear in
 * this file, and `day.test.ts` runs the zone-sensitive assertions under four
 * zones spanning UTC-11 to UTC+14 to prove it.
 *
 * Pure functions throughout: no clock, no environment. `today()` takes the
 * instant as an argument rather than reading it, because a conversation that
 * quietly depends on when it was rendered is one that cannot be tested.
 */

declare const DAY_BRAND: unique symbol;

/** A calendar day, `YYYY-MM-DD`. No zone, no time. */
export type CalendarDay = string & { readonly [DAY_BRAND]: 'calendar-day' };

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Days in a month, Gregorian.
 *
 * Written out rather than obtained from `new Date(y, m, 0).getDate()`, which is
 * the usual trick and is local-time dependent: the two-argument `Date`
 * constructor builds a local timestamp, so the answer can be off by one either
 * side of a DST boundary in zones with unusual rules.
 */
export function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) throw new TimeError(`Month out of range: ${month}`);
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

/** Parse and validate `YYYY-MM-DD`. Rejects 31 February rather than rolling it over. */
export function day(value: string): CalendarDay {
  const match = DAY_PATTERN.exec(value);
  if (!match) throw new TimeError(`Not a calendar day (expected YYYY-MM-DD): ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  if (month < 1 || month > 12) throw new TimeError(`Month out of range in ${value}`);
  if (date < 1 || date > daysInMonth(year, month)) {
    throw new TimeError(
      `Day out of range in ${value}: ${month}/${year} has ${daysInMonth(year, month)} days`,
    );
  }
  return value as CalendarDay;
}

const pad = (value: number, width: number): string => String(value).padStart(width, '0');

export function makeDay(year: number, monthNumber: number, dayNumber: number): CalendarDay {
  return day(`${pad(year, 4)}-${pad(monthNumber, 2)}-${pad(dayNumber, 2)}`);
}

export function yearOf(value: CalendarDay): number {
  return Number(value.slice(0, 4));
}

export function monthNumberOf(value: CalendarDay): number {
  return Number(value.slice(5, 7));
}

export function dayNumberOf(value: CalendarDay): number {
  return Number(value.slice(8, 10));
}

/**
 * The `Date` Postgres round-trips a `date` column through: UTC midnight.
 *
 * Built with `Date.UTC` rather than by parsing the string. `new Date('2026-03-01')`
 * happens to be UTC midnight per spec, but `new Date('2026-3-1')` is local
 * midnight, and the difference between those two literals is one character.
 */
export function toUtcDate(value: CalendarDay): Date {
  return new Date(Date.UTC(yearOf(value), monthNumberOf(value) - 1, dayNumberOf(value)));
}

/**
 * Read a `Date` back as the calendar day it represents.
 *
 * UTC accessors, always. This is the exact line where a reader in Santiago starts
 * seeing a message sent on 1 March filed under 28 February.
 */
export function fromUtcDate(value: Date): CalendarDay {
  if (Number.isNaN(value.getTime())) throw new TimeError('Cannot read an Invalid Date as a day.');
  return makeDay(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
}

/** Move a day by a signed number of days, over the UTC epoch so no zone is involved. */
export function addDays(value: CalendarDay, delta: number): CalendarDay {
  if (!Number.isInteger(delta)) throw new TimeError(`Day delta must be an integer, got ${delta}`);
  return fromUtcDate(new Date(toUtcDate(value).getTime() + delta * 86_400_000));
}

/** Whole days between two calendar days, `to - from`. Negative when `to` is earlier. */
export function daysBetween(from: CalendarDay, to: CalendarDay): number {
  return Math.round((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / 86_400_000);
}

/**
 * Today, in a named zone, from an explicit instant.
 *
 * The zone is required rather than defaulted to the machine's, because "the
 * machine's zone" is the assumption that makes a day divider irreproducible: the
 * server would decide what "Today" means for a reader it has never met. The
 * instant is an argument for the same reason.
 *
 * Uses `en-CA`, whose short date format is ISO `YYYY-MM-DD`. That is a real
 * property of the locale rather than a coincidence worth relying on blindly, so
 * the output is validated by `day()` before it is returned.
 */
export function today(now: Date, timeZone: string): CalendarDay {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return day(`${get('year')}-${get('month')}-${get('day')}`);
}

/**
 * A day's label for display, in the given locale.
 *
 * Formatted from UTC noon rather than UTC midnight. Midnight is the one instant
 * that can render as the previous day in any zone west of UTC, and `Intl` formats
 * in the zone it is given; noon has twelve hours of slack either way, which
 * covers every real offset from -11 to +14. The `timeZone: 'UTC'` below makes
 * that belt-and-braces, and both are kept: the explicit zone is what makes the
 * function's output independent of the machine, and the noon anchor is what keeps
 * it correct if a caller ever passes a different zone.
 */
export function formatDay(value: CalendarDay, locale: string): string {
  const at = new Date(Date.UTC(yearOf(value), monthNumberOf(value) - 1, dayNumberOf(value), 12));
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(at);
}
