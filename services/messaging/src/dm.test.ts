import { describe, expect, it } from 'vitest';

import { dmKeyFor, participantsOf } from './dm';

/**
 * The four lines that make a DM one conversation instead of two.
 *
 * Worth this many tests because the failure is silent and permanent: two channel
 * rows, both visible to both people, each holding half a conversation, with no
 * constraint violated and nothing in any log. By the time somebody notices, the
 * messages are split across two ids and cannot be merged without renumbering
 * every seq in one of them.
 */
describe('the key is sorted', () => {
  it('is the same string whichever way round the pair is given', () => {
    // The whole mechanism. `${a}:${b}` is a perfectly good unique key that
    // produces two different strings for one pair, so both inserts succeed and
    // the product has exactly the bug the key was introduced to prevent.
    expect(dmKeyFor('ana', 'bruno')).toBe(dmKeyFor('bruno', 'ana'));
  });

  it('puts the lower id first', () => {
    expect(dmKeyFor('bruno', 'ana')).toBe('ana:bruno');
  });

  it('holds for cuid-shaped ids', () => {
    const a = 'cm3x9f2b40001qz7h8k2p1n4d';
    const b = 'cm3x9f2b40002qz7h9m3r2p5e';
    expect(dmKeyFor(a, b)).toBe(dmKeyFor(b, a));
    expect(dmKeyFor(a, b)).toBe(`${a}:${b}`);
  });

  it('compares code units, not locale', () => {
    // `localeCompare` is locale-sensitive and ICU-version-sensitive: two
    // processes with different ICU data could order the same pair differently and
    // produce two keys for one pair. `<` compares UTF-16 code units, which is
    // what Postgres's `least`/`greatest` do under the C collation.
    //
    // 'Z' (U+005A) sorts before 'a' (U+0061) by code unit and after it in most
    // locales, which is what makes this pair the discriminating case.
    expect(dmKeyFor('a', 'Z')).toBe('Z:a');
  });
});

describe('inputs that would make the key a lie', () => {
  it('refuses a DM with oneself', () => {
    // A note-to-self is a real feature in some products. It is not one here, and
    // allowing it silently produces a "DM" with one member that renders with no
    // counterpart and no name.
    expect(() => dmKeyFor('ana', 'ana')).toThrow(/two different people/);
  });

  it('refuses an empty id', () => {
    // `':bruno'` satisfies the UNIQUE and fails the CHECK in the migration, so
    // the failure would surface as a constraint violation several layers away.
    expect(() => dmKeyFor('', 'bruno')).toThrow(/empty/);
    expect(() => dmKeyFor('ana', '')).toThrow(/empty/);
  });

  it('refuses an id containing the separator', () => {
    // `dmKeyFor('a:b', 'c')` is `'a:b:c'`, which splits three ways and means
    // nothing. Cuids cannot contain a colon, so this is defence against a caller
    // passing something that is not a user id at all.
    expect(() => dmKeyFor('a:b', 'c')).toThrow(/colon/);
  });
});

describe('reading a key back', () => {
  it('round-trips', () => {
    expect(participantsOf(dmKeyFor('ana', 'bruno'))).toEqual(['ana', 'bruno']);
  });

  it('rejects a key with the wrong number of parts', () => {
    expect(participantsOf('ana')).toBeNull();
    expect(participantsOf('a:b:c')).toBeNull();
  });

  it('rejects a key with an empty side', () => {
    expect(participantsOf(':bruno')).toBeNull();
    expect(participantsOf('ana:')).toBeNull();
  });
});

describe('the sorting property, over many pairs', () => {
  it('order of arguments never changes the key', () => {
    // Deterministic generation, so a failure is reproducible from the index
    // rather than from a seed nobody recorded.
    const ids = Array.from({ length: 60 }, (_, index) =>
      `u${String(index).padStart(3, '0')}${'abcdefghij'[index % 10]!}`,
    );

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const forward = dmKeyFor(ids[i]!, ids[j]!);
        const backward = dmKeyFor(ids[j]!, ids[i]!);
        expect(forward, `${ids[i]!} / ${ids[j]!}`).toBe(backward);
        expect(participantsOf(forward)).toEqual([...[ids[i]!, ids[j]!]].sort());
      }
    }
  });

  it('distinct pairs never collide', () => {
    // The other half: a key that is stable is useless if two different pairs
    // produce it. The colon separator is what guarantees this, and it would fail
    // for a separator that can appear inside an id.
    const ids = ['a', 'ab', 'b', 'ba', 'abc', 'c'];
    const keys = new Map<string, string>();

    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const key = dmKeyFor(ids[i]!, ids[j]!);
        const pair = `${ids[i]!}+${ids[j]!}`;
        expect(keys.has(key), `${key} collides: ${keys.get(key) ?? ''} and ${pair}`).toBe(false);
        keys.set(key, pair);
      }
    }
  });
});
