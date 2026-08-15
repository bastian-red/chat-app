/**
 * How long ago a message was sent.
 *
 * A message happened at an **instant**, unlike the day divider above it: every
 * reader agrees on the moment even though they disagree about which calendar day
 * it falls on. So this module works in `Date`s and `time/day` works in
 * `CalendarDay`s, and the split is the difference between "4 minutes ago", which
 * is the same everywhere, and "Yesterday", which is not.
 *
 * Two rules the implementation exists to keep:
 *
 * 1. **`now` is an argument.** A feed that reads the clock renders differently on
 *    the server and in the browser a few hundred milliseconds later, which in
 *    React is a hydration mismatch: the server writes "2 minutes ago", the client
 *    writes "3 minutes ago", and React discards the server's HTML. Passing the
 *    instant in makes the render a pure function of its props, which is also what
 *    makes it testable without freezing time.
 * 2. **`Intl.RelativeTimeFormat` does the words.** Hand-rolled pluralisation
 *    ("1 minutes ago") is the classic bug here, and the standard library has
 *    shipped this since Node 12. Layer 1 of search-before-building.
 */

/**
 * Cut-offs, in seconds, largest unit last.
 *
 * "just now" covers everything under a minute, and the boundary is exactly one
 * minute rather than the 45 seconds this originally used. Two reasons, the second
 * of which was found by running the formatter rather than by reading it:
 *
 *   - `Intl` would otherwise render a 3-second-old event as "3 seconds ago",
 *     which is noise on a feed that updates live and re-renders every second for
 *     no benefit.
 *   - Below 60 seconds `Math.trunc(magnitude / MINUTE)` is 0, and
 *     `format(0, 'minute')` under `numeric: 'auto'` is the string "this minute".
 *     A 45-second floor therefore produced "this minute" for the 45-to-59-second
 *     window: not wrong exactly, but not what any other row on the feed says, and
 *     nothing in the code hints at it. Anything below a minute is "just now".
 *
 * Above four weeks the answer stops being useful as a distance -- nobody reads
 * "7 weeks ago" as a date -- so `isWithinRelativeHorizon` tells the caller to show
 * the absolute day instead.
 */
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** The longest gap this still expresses as a distance. Beyond it, use `formatDay`. */
export const RELATIVE_HORIZON_SECONDS = 4 * WEEK;

export function isWithinRelativeHorizon(at: Date, now: Date): boolean {
  return Math.abs((now.getTime() - at.getTime()) / 1000) < RELATIVE_HORIZON_SECONDS;
}

/**
 * `at` relative to `now`, in words.
 *
 * Rounds **towards zero**, not to nearest: at 119 seconds "1 minute ago" is true
 * and "2 minutes ago" is not yet. Rounding to nearest would let the feed claim an
 * event happened further in the past than it did, which reads as a bug when the
 * row above it is newer and rounds the other way.
 *
 * A future instant is handled rather than clamped. Clock skew between the API
 * host and the reader's machine is real and routinely a few seconds; "in 4
 * seconds" is at least honest about it, whereas clamping to "just now" hides the
 * skew until something that depends on ordering breaks.
 */
export function relativeTime(at: Date, now: Date, locale = 'en-GB'): string {
  const seconds = (at.getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(seconds);

  if (magnitude < MINUTE) return 'just now';

  // `numeric: 'auto'` is what turns -1 day into "yesterday" rather than "1 day
  // ago". That is the phrasing a person reading a feed expects, and it is a
  // property of the locale rather than of this code.
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const sign = seconds < 0 ? -1 : 1;

  if (magnitude < HOUR) return format.format(sign * Math.trunc(magnitude / MINUTE), 'minute');
  if (magnitude < DAY) return format.format(sign * Math.trunc(magnitude / HOUR), 'hour');
  if (magnitude < WEEK) return format.format(sign * Math.trunc(magnitude / DAY), 'day');
  return format.format(sign * Math.trunc(magnitude / WEEK), 'week');
}

/**
 * The clock time a message was sent, in the reader's zone.
 *
 * Beside every message in the conversation, which makes it the most-rendered
 * string in the product, and the one place a zone mistake is most visible: a
 * message sent at 09:00 in Madrid reads 04:00 to a reader in Santiago, and both
 * are correct. The zone is therefore an argument and comes from the reader's
 * stored `timeZone`, never from the browser -- a browser-derived zone would make
 * the whole conversation shift when somebody travels, including the messages they
 * had already read.
 *
 * `hourCycle: 'h23'` rather than leaving it to the locale. The times sit in a
 * column beside each other, and a locale that renders "9:05 AM" produces a ragged
 * column whose entries are three characters wider half the day. It is also what
 * makes the column tabular in a way `Azeret Mono`'s figures can align.
 */
export function formatTimeOfDay(at: Date, timeZone: string, locale = 'en-GB'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);
}
