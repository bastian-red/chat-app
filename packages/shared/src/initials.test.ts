import { describe, expect, it } from 'vitest';

import { initialsOf, PRESENCE_COLOR_SLOTS, presenceColorSlot } from './initials';

/**
 * U+1F9D1 "person" + U+200D zero-width joiner + U+1F680 "rocket".
 *
 * Written as escapes and named once, never pasted. A ZWJ is invisible in every
 * editor and every diff, so a literal one is a character nobody can review --
 * `scripts/invisible-chars.mjs` is the gate that says so, and this file is the
 * one that broke it. The escape is also self-documenting in a way the rendered
 * glyph is not: the point of the fixture is the joiner, and the joiner is exactly
 * what you cannot see in the glyph.
 */
const ASTRONAUT = '\u{1F9D1}\u{200D}\u{1F680}';

/** U+FFFD, what half a surrogate pair renders as. The bug, spelled out. */
const REPLACEMENT = '�';

describe('initialsOf', () => {
  // Every expectation below was produced by running the function and pasting the
  // output, including the ones that look obvious. "Ana Maria Ruiz Perez" -> "AP"
  // (first and last, not first and second) is a decision, and writing "AM" here
  // from memory would have quietly changed it.
  it.each([
    ['Ana Ruiz', 'AR'],
    ['ana ruiz', 'AR'],
    ['Ana', 'A'],
    ['  Ana   Ruiz  ', 'AR'],
    ['Ana Maria Ruiz Perez', 'AP'],
    ['José Ángel', 'JÁ'],
    ['östlund test', 'ÖT'],
  ])('reads %j as %j', (name, expected) => {
    expect(initialsOf(name)).toBe(expected);
  });

  it('never returns an empty chip', () => {
    // A blank avatar is a person nobody can name. "?" is at least a thing a
    // screen reader can announce and a sighted reader can ask about.
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });

  it('takes whole graphemes, not code units', () => {
    // The failure this rules out: `name[0]` on a name beginning with an astral
    // character returns half a surrogate pair, which renders as U+FFFD. ASTRONAUT
    // is a ZWJ sequence of three code points spanning five UTF-16 code units, so a
    // naive implementation produces a mojibake avatar for a real user.
    //
    // Asserted rather than assumed: if `Intl.Segmenter` did not treat the sequence
    // as one grapheme, the two expectations below would pass for the wrong reason.
    expect(ASTRONAUT.length).toBe(5);
    expect([
      ...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(ASTRONAUT),
    ]).toHaveLength(1);

    expect(initialsOf('李明')).toBe('李');
    expect(initialsOf(`${ASTRONAUT} Ana`)).toBe(`${ASTRONAUT}A`);
    expect(initialsOf(`Ana ${ASTRONAUT}`)).toBe(`A${ASTRONAUT}`);
    expect(initialsOf(`${ASTRONAUT} Ana`)).not.toContain(REPLACEMENT);
  });

  it('is at most two graphemes long', () => {
    for (const name of ['Ana Maria Ruiz Perez', 'A B C D E F', '李明 王']) {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
      expect([...segmenter.segment(initialsOf(name))].length).toBeLessThanOrEqual(2);
    }
  });
});

describe('presenceColorSlot', () => {
  it('is stable for the same id', () => {
    // The property that matters: two gateway replicas and two browsers must give
    // the same person the same swatch, or the presence bar contradicts itself the
    // moment a second replica serves a client. A counter or Math.random would
    // pass every other test in this file and fail this one in production only.
    expect(presenceColorSlot('user-1')).toBe(presenceColorSlot('user-1'));
    expect(presenceColorSlot('user-1')).toBe(4);
    expect(presenceColorSlot('user-2')).toBe(5);
    expect(presenceColorSlot('clx0000000000000000000000')).toBe(6);
  });

  it('always lands inside the palette', () => {
    // The `>>> 0` in the hash is what this covers. JavaScript's bitwise operators
    // produce signed 32-bit results, so without it the modulo can return a
    // negative slot, which indexes off the end of the palette and renders an
    // undefined CSS custom property -- and an undeclared property inside calc()
    // invalidates the whole declaration.
    for (let index = 0; index < 5000; index += 1) {
      const slot = presenceColorSlot(`clx${index}`);
      expect(Number.isInteger(slot)).toBe(true);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(PRESENCE_COLOR_SLOTS);
    }
    expect(presenceColorSlot('')).toBeGreaterThanOrEqual(0);
  });

  it('spreads across every slot rather than clustering', () => {
    // Not a uniformity proof, just a floor: a hash that returned one value for
    // everything would satisfy both tests above and make every avatar identical.
    const seen = new Set<number>();
    for (let index = 0; index < 1000; index += 1) seen.add(presenceColorSlot(`user-${index}`));
    expect(seen.size).toBe(PRESENCE_COLOR_SLOTS);
  });

  it('honours a smaller palette', () => {
    for (let index = 0; index < 200; index += 1) {
      expect(presenceColorSlot(`user-${index}`, 3)).toBeLessThan(3);
    }
  });
});
