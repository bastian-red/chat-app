import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  addDays,
  type CalendarDay,
  day,
  daysBetween,
  daysInMonth,
  formatDay,
  fromUtcDate,
  makeDay,
  TimeError,
  today,
  toUtcDate,
} from './day';

/**
 * Four zones spanning the whole inhabited range: UTC-11, UTC-3 (the machine that
 * wrote this), UTC, and UTC+14. Every zone-sensitive assertion runs under all
 * four.
 *
 * This is the point of the module. A `date` column comes back from Postgres as
 * UTC midnight, and UTC midnight on the ninth is *the eighth* everywhere west of
 * Greenwich. A single `getDate()` instead of `getUTCDate()` anywhere in the day
 * path files a message under the wrong divider for every reader west of it -- a
 * conversation with a "Yesterday" heading over messages sent today, and nothing
 * to indicate it is wrong.
 *
 * Reading `process.env.TZ` here is also what keeps the name honest in
 * `turbo.json`: turbo runs in strict env mode, so a `TZ` it does not declare
 * never reaches this process, and `TZ=Pacific/Kiritimati pnpm test` would then
 * quietly run in the machine's own zone and pass while proving nothing. The
 * `scripts/env-contract.mjs` rule that TZ must be read by something is satisfied
 * by this file.
 */
const ZONES = ['Pacific/Midway', 'America/Santiago', 'UTC', 'Pacific/Kiritimati'] as const;
const ORIGINAL_TZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

afterAll(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe('parsing', () => {
  it('accepts a well-formed day', () => {
    expect(day('2026-03-09')).toBe('2026-03-09');
  });

  it.each(['2026-3-9', '09-03-2026', '2026-03-09T00:00:00Z', '', 'tomorrow'])(
    'rejects %s as a day',
    (value) => {
      expect(() => day(value)).toThrow(TimeError);
    },
  );

  it('rejects a day that does not exist instead of rolling it over', () => {
    // `new Date('2026-02-31')` is 3 March. Silently accepting that is how a day
    // computed from a bad instant lands in the wrong month and files a whole
    // day's conversation under a heading nobody can find.
    expect(() => day('2026-02-31')).toThrow(/has 28 days/);
    expect(() => day('2026-04-31')).toThrow(/has 30 days/);
    expect(() => day('2026-01-00')).toThrow(TimeError);
  });

  it('knows February in leap and century years', () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(day('2024-02-29')).toBe('2024-02-29');
    expect(() => day('2100-02-29')).toThrow(TimeError);
  });

  it('rejects a month outside 1-12 rather than computing with it', () => {
    expect(() => daysInMonth(2026, 0)).toThrow(TimeError);
    expect(() => daysInMonth(2026, 13)).toThrow(TimeError);
    expect(() => makeDay(2026, 13, 1)).toThrow(TimeError);
  });
});

describe('arithmetic', () => {
  it('adds and subtracts across month and year ends', () => {
    expect(addDays(day('2026-02-28'), 1)).toBe('2026-03-01');
    expect(addDays(day('2024-02-28'), 1)).toBe('2024-02-29');
    expect(addDays(day('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addDays(day('2026-01-01'), -1)).toBe('2025-12-31');
  });

  it('refuses a fractional delta rather than silently truncating it', () => {
    expect(() => addDays(day('2026-03-09'), 1.5)).toThrow(TimeError);
  });

  it('counts whole days in both directions', () => {
    expect(daysBetween(day('2026-03-01'), day('2026-03-04'))).toBe(3);
    expect(daysBetween(day('2026-03-04'), day('2026-03-01'))).toBe(-3);
    expect(daysBetween(day('2026-02-27'), day('2026-03-02'))).toBe(3);
    expect(daysBetween(day('2026-03-09'), day('2026-03-09'))).toBe(0);
  });

  it.each(ZONES)('adds days without drifting in %s', (zone) => {
    process.env.TZ = zone;
    // DST boundaries in zones that have one. Adding 86_400_000 ms across a
    // spring-forward is 23 hours of local time, so any implementation that reads
    // the result with a local accessor lands on the wrong day.
    expect(addDays(day('2026-03-28'), 1)).toBe('2026-03-29');
    expect(addDays(day('2026-10-24'), 1)).toBe('2026-10-25');
    expect(daysBetween(day('2026-03-28'), day('2026-03-29'))).toBe(1);
  });
});

describe('the Postgres date round trip', () => {
  it.each(ZONES)('survives in %s', (zone) => {
    process.env.TZ = zone;
    for (const value of ['2026-01-01', '2026-03-01', '2026-06-15', '2026-12-31'] as CalendarDay[]) {
      expect(fromUtcDate(toUtcDate(value))).toBe(value);
    }
  });

  it.each(ZONES)('reads UTC midnight as that day, not the one before, in %s', (zone) => {
    process.env.TZ = zone;
    // The specific failure: UTC midnight on 1 March is 28 February local in every
    // zone west of UTC, and 1 March 14:00 in Kiritimati. This is exactly the
    // value Prisma hands back for a `date` column.
    expect(fromUtcDate(new Date(Date.UTC(2026, 2, 1)))).toBe('2026-03-01');
  });

  it('refuses an Invalid Date rather than producing NaN-NaN-NaN', () => {
    expect(() => fromUtcDate(new Date('not a date'))).toThrow(TimeError);
  });
});

describe('today in an explicit zone', () => {
  it('reads one instant as two different days either side of the date line', () => {
    // 23:30 UTC on 1 March. Midway is still on 1 March; Kiritimati is already on
    // the 2nd. A message sent at that instant sits under "1 March" for one reader
    // and under "Today" for the other, and both are right.
    const instant = new Date('2026-03-01T23:30:00Z');
    expect(today(instant, 'Pacific/Midway')).toBe('2026-03-01');
    expect(today(instant, 'Pacific/Kiritimati')).toBe('2026-03-02');
  });

  it.each(ZONES)('ignores the machine zone when the process runs in %s', (zone) => {
    process.env.TZ = zone;
    const instant = new Date('2026-06-15T12:00:00Z');
    expect(today(instant, 'Europe/Madrid')).toBe('2026-06-15');
  });
});

describe('display', () => {
  // Both strings below were produced by running Intl and pasting the output, not
  // recalled: `en-GB` writes "9 Mar 2026" with no comma, and `en-US` writes
  // "Mar 9, 2026" with one. Typing either from memory is how a correct formatter
  // fails a wrong assertion and gets "fixed" until the test passes.
  it('labels a day in the reader locale', () => {
    expect(formatDay(day('2026-03-09'), 'en-GB')).toBe('9 Mar 2026');
    expect(formatDay(day('2026-03-09'), 'en-US')).toBe('Mar 9, 2026');
  });

  it.each(ZONES)('labels the first of the month as that day in %s', (zone) => {
    process.env.TZ = zone;
    // Formatting from UTC midnight would render "28 Feb 2026" here for every zone
    // west of UTC. The module anchors at UTC noon for exactly this.
    expect(formatDay(day('2026-03-01'), 'en-GB')).toBe('1 Mar 2026');
  });
});
