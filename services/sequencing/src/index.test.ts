import { describe, expect, it } from 'vitest';

import { isContiguousRun, MAX_HELD, missingRanges, ReorderBuffer, type Sequenced } from './index';

/**
 * The reorder buffer, tested the way the network actually behaves.
 *
 * Half of this file is property tests over pseudo-random interleavings rather
 * than hand-picked cases. That is deliberate: the bugs in a reorder buffer are
 * not "it failed on [3, 1, 2]", they are "it failed on one particular
 * interleaving out of the thousands a real connection produces", and a suite of
 * examples finds those by luck. The generator below is seeded, so a failure is
 * reproducible from the seed printed in the assertion.
 */

interface Line extends Sequenced {
  body: string;
}

const line = (seq: number): Line => ({ seq, body: `message ${seq}` });

const run = (from: number, to: number): Line[] => {
  const out: Line[] = [];
  for (let seq = from; seq <= to; seq += 1) out.push(line(seq));
  return out;
};

/**
 * A deterministic PRNG (mulberry32).
 *
 * `Math.random()` would make a failure unreproducible, which is the one thing a
 * property test must never be: the whole value is that when it fails you can run
 * the exact case again.
 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [out[index], out[swap]] = [out[swap]!, out[index]!];
  }
  return out;
}

describe('the ordinary case: everything arrives in order', () => {
  it('delivers each message as it comes', () => {
    const buffer = new ReorderBuffer<Line>();
    for (const message of run(1, 5)) {
      const result = buffer.accept(message);
      expect(result.delivered).toEqual([message]);
      expect(result.gap).toBeNull();
      expect(result.duplicate).toBe(false);
    }
    expect(buffer.position).toBe(5);
    expect(buffer.heldCount).toBe(0);
  });

  it('starts from a mark, for a client that already has history', () => {
    // A client opening a channel is handed the newest page and its lastSeq. The
    // socket then delivers seq 41 onwards, and 40 is not a gap.
    const buffer = new ReorderBuffer<Line>(40);
    expect(buffer.accept(line(41)).delivered).toEqual([line(41)]);
    expect(buffer.accept(line(42)).gap).toBeNull();
  });
});

describe('the same message twice', () => {
  it('drops the second copy', () => {
    // The single most common case on the send path: a client sees its own message
    // once as the ack of `message.send` and once as the `message.new` broadcast.
    // Rendering both is the duplicate-message bug every chat has had.
    const buffer = new ReorderBuffer<Line>();
    expect(buffer.accept(line(1)).delivered).toHaveLength(1);

    const again = buffer.accept(line(1));
    expect(again.delivered).toEqual([]);
    expect(again.duplicate).toBe(true);
    expect(buffer.position).toBe(1);
  });

  it('drops a redelivery from well behind the mark', () => {
    const buffer = new ReorderBuffer<Line>(100);
    expect(buffer.accept(line(3)).duplicate).toBe(true);
  });

  it('drops an early message offered twice, without holding it twice', () => {
    const buffer = new ReorderBuffer<Line>();
    buffer.accept(line(5));
    const again = buffer.accept(line(5));

    expect(again.duplicate).toBe(true);
    expect(buffer.heldCount).toBe(1);
  });
});

describe('a gap', () => {
  it('holds an early message rather than dropping it', () => {
    // The distinction that matters. An early message is real -- it is just early
    // -- and a buffer that dropped it would need the server to send it again,
    // which the server will never do.
    const buffer = new ReorderBuffer<Line>();
    const result = buffer.accept(line(3));

    expect(result.delivered).toEqual([]);
    expect(result.duplicate).toBe(false);
    expect(buffer.heldCount).toBe(1);
  });

  it('names exactly what is missing', () => {
    const buffer = new ReorderBuffer<Line>();
    expect(buffer.accept(line(4)).gap).toEqual({ fromSeq: 1, toSeq: 3 });
  });

  it('reports the gap again on every call, not once', () => {
    // A one-shot signal is lost by any client that was mid-render when it fired,
    // and the hole then never fills. Recomputing from state means an ignored gap
    // is reported again on the next arrival.
    const buffer = new ReorderBuffer<Line>();
    buffer.accept(line(4));
    expect(buffer.accept(line(5)).gap).toEqual({ fromSeq: 1, toSeq: 3 });
    expect(buffer.accept(line(6)).gap).toEqual({ fromSeq: 1, toSeq: 3 });
  });

  it('flushes everything contiguous the moment the hole is filled', () => {
    // Holding 7, 8, 9 and receiving 6 delivers all four, in order, in one pass.
    const buffer = new ReorderBuffer<Line>(5);
    buffer.accept(line(9));
    buffer.accept(line(7));
    buffer.accept(line(8));
    expect(buffer.heldCount).toBe(3);

    const result = buffer.accept(line(6));
    expect(result.delivered.map((message) => message.seq)).toEqual([6, 7, 8, 9]);
    expect(result.gap).toBeNull();
    expect(buffer.position).toBe(9);
    expect(buffer.heldCount).toBe(0);
  });

  it('narrows the gap when the hole is filled from the far end', () => {
    const buffer = new ReorderBuffer<Line>();
    buffer.accept(line(5));
    expect(buffer.accept(line(4)).gap).toEqual({ fromSeq: 1, toSeq: 3 });
    expect(buffer.accept(line(2)).gap).toEqual({ fromSeq: 1, toSeq: 1 });
  });
});

describe('catching up in bulk', () => {
  it('accepts an unordered page and delivers it in order', () => {
    // A fetch result is not required to arrive sorted. Without the sort inside
    // acceptAll, [9, 7, 8] would deliver 7 and 8 and hold 9 for no reason.
    const buffer = new ReorderBuffer<Line>(6);
    const result = buffer.acceptAll([line(9), line(7), line(8)]);

    expect(result.delivered.map((message) => message.seq)).toEqual([7, 8, 9]);
    expect(result.gap).toBeNull();
  });

  it('splices a fetched range into what was already held', () => {
    // The real reconnect shape: the socket delivered 20-22 while 15-19 were
    // missing, the client fetched the gap, and all eight lines have to land in
    // one ordered run.
    const buffer = new ReorderBuffer<Line>(14);
    buffer.acceptAll(run(20, 22));
    expect(buffer.heldCount).toBe(3);

    const result = buffer.acceptAll(run(15, 19));
    expect(result.delivered.map((message) => message.seq)).toEqual([
      15, 16, 17, 18, 19, 20, 21, 22,
    ]);
    expect(buffer.position).toBe(22);
  });

  it('a page that repeats one line and fills a gap is news, not a duplicate', () => {
    // Overlap is normal: a catch-up fetch is inclusive at its boundary more often
    // than not. Reporting the whole page as a duplicate would make the caller
    // discard the part it needed.
    const buffer = new ReorderBuffer<Line>(5);
    buffer.accept(line(6));
    const result = buffer.acceptAll([line(6), line(7)]);

    expect(result.duplicate).toBe(false);
    expect(result.delivered.map((message) => message.seq)).toEqual([7]);
  });

  it('a page of nothing but repeats is a duplicate', () => {
    const buffer = new ReorderBuffer<Line>(10);
    expect(buffer.acceptAll(run(1, 5)).duplicate).toBe(true);
  });

  it('an empty page is not a duplicate', () => {
    // "Nothing was missing" and "everything I sent you was old" are different
    // answers, and a caller that treats an empty catch-up as a duplicate would
    // log a warning on every quiet reconnect.
    expect(new ReorderBuffer<Line>().acceptAll([]).duplicate).toBe(false);
  });
});

describe('giving up', () => {
  it('reports overflow past the held ceiling', () => {
    // A gap that never fills -- a fetch that keeps failing, a channel the reader
    // lost access to mid-stream -- would otherwise accumulate every subsequent
    // message in memory forever.
    const buffer = new ReorderBuffer<Line>();
    for (let seq = 2; seq <= MAX_HELD + 2; seq += 1) buffer.accept(line(seq));

    expect(buffer.overflowed).toBe(true);
    expect(buffer.heldCount).toBeGreaterThan(MAX_HELD);
  });

  it('is not overflowed at exactly the ceiling', () => {
    // The boundary, pinned. Off by one here means either a buffer that gives up
    // one message early or one that never gives up at all.
    const buffer = new ReorderBuffer<Line>();
    for (let seq = 2; seq <= MAX_HELD + 1; seq += 1) buffer.accept(line(seq));

    expect(buffer.heldCount).toBe(MAX_HELD);
    expect(buffer.overflowed).toBe(false);
  });

  it('reset clears the hold and jumps the mark', () => {
    const buffer = new ReorderBuffer<Line>();
    buffer.acceptAll(run(50, 60));
    expect(buffer.heldCount).toBe(11);

    buffer.reset(60);
    expect(buffer.heldCount).toBe(0);
    expect(buffer.position).toBe(60);
    // And the refetched overlap does not render twice.
    expect(buffer.acceptAll(run(55, 60)).delivered).toEqual([]);
  });
});

describe('inputs that cannot be right', () => {
  it('rejects a seq of zero', () => {
    // Seq counts from one so that a read marker of zero can mean "nothing read".
    // A zero arriving here means something upstream lost that distinction.
    expect(() => new ReorderBuffer<Line>().accept(line(0))).toThrow(RangeError);
  });

  it('rejects a fractional seq', () => {
    // The shape a client would produce if it ever tried to invent a position
    // between two messages -- which is exactly what a dense sequence forbids.
    expect(() => new ReorderBuffer<Line>().accept({ seq: 1.5, body: 'x' })).toThrow(RangeError);
  });

  it('rejects a negative mark', () => {
    expect(() => new ReorderBuffer<Line>(-1)).toThrow(RangeError);
    expect(() => new ReorderBuffer<Line>().reset(-1)).toThrow(RangeError);
  });
});

describe('properties, over pseudo-random interleavings', () => {
  it('every shuffled stream delivers exactly once, in order', () => {
    // The core property. However the network reorders a run, the buffer emits
    // each message exactly once and in ascending seq -- which is what "one total
    // order per channel" means on the receiving side.
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = rng(seed);
      const buffer = new ReorderBuffer<Line>();
      const delivered: number[] = [];

      for (const message of shuffled(run(1, 40), random)) {
        delivered.push(...buffer.accept(message).delivered.map((entry) => entry.seq));
      }

      expect(delivered, `seed ${seed}`).toEqual(run(1, 40).map((message) => message.seq));
      expect(buffer.heldCount, `seed ${seed} left messages held`).toBe(0);
    }
  });

  it('duplicates anywhere in the stream change nothing', () => {
    // Every message offered twice, in a random order. The delivered run must be
    // identical to the one without duplicates.
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = rng(seed);
      const buffer = new ReorderBuffer<Line>();
      const delivered: number[] = [];
      const doubled = [...run(1, 30), ...run(1, 30)];

      for (const message of shuffled(doubled, random)) {
        delivered.push(...buffer.accept(message).delivered.map((entry) => entry.seq));
      }

      expect(delivered, `seed ${seed}`).toEqual(run(1, 30).map((message) => message.seq));
    }
  });

  it('a stream with a hole delivers nothing past the hole until it is filled', () => {
    // The safety property, and the one a naive buffer gets wrong: it is not
    // enough to eventually deliver everything, nothing after a gap may be
    // rendered before the gap closes, or the conversation reads out of order for
    // as long as the fetch takes.
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = rng(seed);
      const missing = 1 + Math.floor(random() * 20);
      const buffer = new ReorderBuffer<Line>();
      const delivered: number[] = [];

      const withHole = run(1, 25).filter((message) => message.seq !== missing);
      for (const message of shuffled(withHole, random)) {
        delivered.push(...buffer.accept(message).delivered.map((entry) => entry.seq));
      }

      expect(
        delivered.every((seq) => seq < missing),
        `seed ${seed}`,
      ).toBe(true);
      expect(buffer.position, `seed ${seed}`).toBe(missing - 1);

      // And filling it releases the rest, in order, in one pass.
      const rest = buffer.accept(line(missing)).delivered.map((entry) => entry.seq);
      expect(rest, `seed ${seed}`).toEqual(run(missing, 25).map((message) => message.seq));
    }
  });
});

describe('isContiguousRun', () => {
  it('accepts a complete run in any order', () => {
    // What the integration lane asserts about eight concurrent senders: the seq
    // set is exactly 1..N, whatever order the rows came back in.
    expect(isContiguousRun([{ seq: 3 }, { seq: 1 }, { seq: 2 }])).toBe(true);
  });

  it('rejects a hole', () => {
    expect(isContiguousRun([{ seq: 1 }, { seq: 3 }])).toBe(false);
  });

  it('rejects a duplicate', () => {
    // [1, 2, 2] has three entries and reaches 2, so a length-and-max check would
    // pass it. Two messages sharing a seq is the exact failure the unique index
    // exists to prevent, so it must fail here too.
    expect(isContiguousRun([{ seq: 1 }, { seq: 2 }, { seq: 2 }])).toBe(false);
  });

  it('an empty run is contiguous', () => {
    expect(isContiguousRun([])).toBe(true);
  });

  it('can start anywhere', () => {
    expect(isContiguousRun([{ seq: 10 }, { seq: 11 }], 10)).toBe(true);
    expect(isContiguousRun([{ seq: 10 }, { seq: 11 }], 1)).toBe(false);
  });
});

describe('missingRanges', () => {
  it('finds nothing in a complete run', () => {
    expect(missingRanges([1, 2, 3], 1, 3)).toEqual([]);
  });

  it('collapses a long hole into one range', () => {
    // A gap of 400 must not be 400 objects.
    expect(missingRanges([1, 500], 1, 500)).toEqual([{ fromSeq: 2, toSeq: 499 }]);
  });

  it('finds several holes', () => {
    expect(missingRanges([1, 4, 7], 1, 8)).toEqual([
      { fromSeq: 2, toSeq: 3 },
      { fromSeq: 5, toSeq: 6 },
      { fromSeq: 8, toSeq: 8 },
    ]);
  });

  it('finds a hole that runs to the end', () => {
    expect(missingRanges([1, 2], 1, 5)).toEqual([{ fromSeq: 3, toSeq: 5 }]);
  });
});
