import { describe, expect, it } from 'vitest';

import {
  presenceGlyph,
  presenceLabel,
  presenceSummary,
  presenceWord,
  typingSummary,
  unreadBadge,
  type RosterEntry,
} from './presence-words';

const entry = (name: string, overrides: Partial<RosterEntry> = {}): RosterEntry => ({
  userId: name.toLowerCase(),
  name,
  state: 'online',
  ...overrides,
});

/**
 * Every string here is a channel that carries state without colour.
 *
 * The measurement that makes this a requirement rather than a preference is in
 * `apps/web/lib/contrast.test.ts`: online-green and away-amber separate by about
 * 1.04:1 in greyscale in dark mode. To a deuteranopic reader they are the same
 * dot. `e2e/tests/state-legibility.spec.ts` renders the app in forced greyscale
 * and asserts these words are still there.
 */
describe('one person s state', () => {
  it('is a word, not a colour', () => {
    expect(presenceWord('online')).toBe('Online');
    expect(presenceWord('away')).toBe('Away');
    expect(presenceWord('offline')).toBe('Offline');
  });

  it('is three distinct glyphs, not three colours of one', () => {
    // A filled circle, a hollow circle and a dash differ in shape. Three
    // `●` in three colours would be one channel wearing a disguise.
    const glyphs = [presenceGlyph('online'), presenceGlyph('away'), presenceGlyph('offline')];
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe('the accessible name of a roster row', () => {
  it('is the name and the state', () => {
    expect(presenceLabel(entry('Ana Ruiz'))).toBe('Ana Ruiz, online');
  });

  it('says how many tabs, because two tabs is one person', () => {
    // Without this, a reader counts three names in a roster that says three
    // people and finds two of them are the same colleague.
    expect(presenceLabel(entry('Ana Ruiz', { connections: 2 }))).toBe('Ana Ruiz, online, 2 tabs');
  });

  it('does not mention one tab', () => {
    expect(presenceLabel(entry('Ana Ruiz', { connections: 1 }))).toBe('Ana Ruiz, online');
  });
});

describe('who else is here', () => {
  it('says nobody, rather than rendering an empty bar', () => {
    // An empty presence bar and a broken presence bar are the same pixels.
    expect(presenceSummary([])).toBe('Nobody else is here');
  });

  it('says "1 other person", never "1 person"', () => {
    // With one colleague present, "1 person here" reads as though the reader is
    // not here themselves. The roster is always about other people.
    expect(presenceSummary([entry('Ana Ruiz')])).toBe('1 other person is here');
  });

  it('counts the rest', () => {
    expect(presenceSummary([entry('Ana Ruiz'), entry('Bruno Salas')])).toBe(
      '2 other people are here',
    );
  });

  it('does not count somebody who has gone', () => {
    // The roster carries offline members so the sidebar can grey them out. They
    // are in the list and they are not here.
    expect(presenceSummary([entry('Ana Ruiz'), entry('Bruno Salas', { state: 'offline' })])).toBe(
      '1 other person is here',
    );
  });

  it('counts somebody who is away as present', () => {
    // "Away" is at their desk and idle, which is a different answer to "can I
    // expect a reply" than "gone". Collapsing it into offline makes everybody at
    // lunch look like they have gone home.
    expect(presenceSummary([entry('Ana Ruiz', { state: 'away' })])).toBe('1 other person is here');
  });
});

describe('who is typing', () => {
  it('is null when nobody is, not an empty string', () => {
    // An empty string rendered into a live region is announced as a pause.
    expect(typingSummary([])).toBeNull();
  });

  it('names one person', () => {
    expect(typingSummary(['Ana'])).toBe('Ana is typing');
  });

  it('names two', () => {
    expect(typingSummary(['Ana', 'Bruno'])).toBe('Ana and Bruno are typing');
  });

  it('counts three or more', () => {
    // Past two the list is noise and the count is the useful fact.
    expect(typingSummary(['Ana', 'Bruno', 'Carla'])).toBe('3 people are typing');
  });

  it('does not count the same person twice', () => {
    // Two tabs typing is one person typing. The typing set is keyed by socket on
    // the server, so this is reachable rather than theoretical.
    expect(typingSummary(['Ana', 'Ana'])).toBe('Ana is typing');
  });

  it('ignores a blank name rather than announcing a pause', () => {
    expect(typingSummary(['   '])).toBeNull();
  });
});

describe('the unread badge', () => {
  it('is null at zero, so no badge renders', () => {
    expect(unreadBadge(0)).toBeNull();
    expect(unreadBadge(-3)).toBeNull();
  });

  it('reads the number out in full even when the badge is capped', () => {
    // The cap exists because four digits break the sidebar row. Speech has no
    // layout to break, and "ninety nine plus unread" tells a screen-reader user
    // less than the real number.
    expect(unreadBadge(1)).toEqual({ text: '1', label: '1 unread message' });
    expect(unreadBadge(99)).toEqual({ text: '99', label: '99 unread messages' });
    expect(unreadBadge(150)).toEqual({ text: '99+', label: '150 unread messages' });
  });

  it('is singular at one', () => {
    expect(unreadBadge(1)?.label).toBe('1 unread message');
    expect(unreadBadge(2)?.label).toBe('2 unread messages');
  });
});
