import type { PresenceState } from './contracts/primitives';

/**
 * The words that go beside a roster entry, and the words that say who is typing.
 *
 * They live here rather than in `services/presence` because the **browser**
 * renders them and that package imports `ioredis`: a web bundle reaching for
 * `presenceLabel` would pull a Redis client into it. The service re-exports
 * these, so nothing on the server changed.
 *
 * One implementation, not two, for a reason more specific than tidiness. The same
 * sentence appears in three places -- a chip's `title`, its accessible name, and
 * the live region that announces roster changes -- and a screen-reader user
 * hearing "Ana Ruiz, online" while a sighted colleague reads "Ana (available)" is
 * two descriptions of one fact.
 *
 * The design rule these satisfy: **presence is never colour alone.** In dark mode
 * the green of `online` and the amber of `away` separate by about 1.04:1 in
 * greyscale, which is to say not at all, so the word is what carries the state
 * and the dot is decoration.
 */

export interface RosterEntry {
  userId: string;
  name: string;
  state: PresenceState;
  /** How many sockets this person has open. Two tabs is one person. */
  connections?: number;
}

/**
 * The state of one person, as a word.
 *
 * Exported separately from `presenceLabel` because the sidebar shows the word on
 * its own beside a name it has already rendered, and duplicating the name there
 * would read as a stutter.
 */
export function presenceWord(state: PresenceState): string {
  switch (state) {
    case 'online':
      return 'Online';
    case 'away':
      return 'Away';
    default:
      return 'Offline';
  }
}

/**
 * The glyph beside the word.
 *
 * Three distinct shapes, not three colours of one shape: a filled circle, a
 * hollow circle, a dash. Rendered `aria-hidden` because `presenceWord` already
 * says it -- a screen reader hearing "black circle Online" is worse off than one
 * hearing "Online".
 */
export function presenceGlyph(state: PresenceState): string {
  switch (state) {
    case 'online':
      return '●';
    case 'away':
      return '○';
    default:
      return '—';
  }
}

/** The accessible name of one roster row. Never just a colour and two letters. */
export function presenceLabel(entry: RosterEntry): string {
  // Two tabs is one person. Saying so is what stops a reader wondering why the
  // roster says three people and they can only find two names.
  const tabs = (entry.connections ?? 1) > 1 ? `, ${String(entry.connections)} tabs` : '';
  return `${entry.name}, ${presenceWord(entry.state).toLowerCase()}${tabs}`;
}

/**
 * "Who else is in this channel right now."
 *
 * It is handed **everybody except the reader**. The gateway broadcasts the whole
 * roster, including the person receiving it, because a roster that varied by
 * recipient would have to be built per socket -- so the component filters, and
 * this function's whole vocabulary is about other people.
 *
 * "1 other person", not "1 person". Presence answers "who else is here", and the
 * bare count is ambiguous the moment the reader wonders whether they are in it:
 * with one colleague in the channel, "1 person here" reads as though the reader
 * is not.
 */
export function presenceSummary(entries: readonly RosterEntry[]): string {
  const here = entries.filter((entry) => entry.state !== 'offline');
  if (here.length === 0) return 'Nobody else is here';
  return here.length === 1 ? '1 other person is here' : `${String(here.length)} other people are here`;
}

/**
 * "Ana is typing", and what to say when three people are.
 *
 * Names rather than a count for one and two people, because a chat's typing
 * indicator is read as "should I wait?" and the answer depends on who. Past two
 * it becomes noise and the count is more useful than the list.
 *
 * Returns null rather than an empty string when nobody is typing: an empty string
 * rendered into a live region is announced as a pause, and a component branching
 * on `!== null` is clearer than one branching on `!== ''`.
 */
export function typingSummary(names: readonly string[]): string | null {
  const unique = [...new Set(names.filter((name) => name.trim() !== ''))];
  if (unique.length === 0) return null;
  if (unique.length === 1) return `${unique[0]!} is typing`;
  if (unique.length === 2) return `${unique[0]!} and ${unique[1]!} are typing`;
  return `${String(unique.length)} people are typing`;
}

/**
 * The unread badge's text, and its accessible name.
 *
 * Capped at "99+" for the badge because a four-digit number breaks the sidebar
 * row, and *not* capped in the accessible name, because "ninety nine plus" tells
 * a screen-reader user less than the real number does and there is no layout to
 * break in speech.
 */
export function unreadBadge(count: number): { text: string; label: string } | null {
  if (count <= 0) return null;
  return {
    text: count > 99 ? '99+' : String(count),
    label: count === 1 ? '1 unread message' : `${String(count)} unread messages`,
  };
}
