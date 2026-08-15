/**
 * The BIGINT narrowing, which is the only thing in this package that is true
 * without a database and the only thing in it that fails silently.
 *
 * Everything else here is a row lock, a unique violation or a transaction, all of
 * which are proved in the integration lane against real Postgres. `Number(bigint)`
 * is different: it is always defined, never throws on its own, and starts lying at
 * 2^53. Two messages that disagree about their own seq is the one outcome this
 * project exists to make impossible, so the boundary gets a test.
 */
import { describe, expect, it } from 'vitest';

import { narrowSeq } from './messaging-repository';

const MAX_SAFE = Number.MAX_SAFE_INTEGER; // 9007199254740991

describe('narrowSeq', () => {
  it('narrows the values a real channel actually holds', () => {
    expect(narrowSeq(1n, 'messages.seq')).toBe(1);
    expect(narrowSeq(0n, 'channel_members.last_read_seq')).toBe(0);
    expect(narrowSeq(4096n, 'messages.seq')).toBe(4096);
  });

  it('accepts a number unchanged, so a caller that already narrowed is safe', () => {
    expect(narrowSeq(7, 'messages.seq')).toBe(7);
  });

  it('accepts the largest value that survives the conversion', () => {
    expect(narrowSeq(BigInt(MAX_SAFE), 'messages.seq')).toBe(MAX_SAFE);
  });

  it('throws on the first value that would be silently changed', () => {
    // This is the whole point. Number(9007199254740993n) is 9007199254740992:
    // no error, no warning, and a seq that now collides with its neighbour.
    const unsafe = BigInt(MAX_SAFE) + 2n;
    expect(Number(unsafe)).toBe(MAX_SAFE + 1); // the silent lie, pinned
    expect(() => narrowSeq(unsafe, 'messages.seq')).toThrow(RangeError);
  });

  it('names the column, because the caller sees this without a query in hand', () => {
    expect(() => narrowSeq(BigInt(MAX_SAFE) + 2n, 'channels.next_seq')).toThrow(
      /channels\.next_seq/,
    );
  });

  it('rejects a non-integer number rather than rounding it', () => {
    expect(() => narrowSeq(1.5, 'messages.seq')).toThrow(RangeError);
  });
});
