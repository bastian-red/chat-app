/**
 * The reorder buffer: what a client does with messages that arrive out of order,
 * twice, or not at all.
 *
 * **This service has no I/O and no dependencies.** It is a state machine over
 * sequence numbers, which is why it can be exhaustively tested in the gate lane
 * -- shuffled streams, duplicated frames, gaps of every size, a reconnect in the
 * middle -- in milliseconds and with no database anywhere. The half that needs
 * Postgres (allocating the numbers) lives in `services/messaging`; the half that
 * needs a socket (asking for a gap to be filled) lives in the client. Both call
 * into here.
 *
 * ## Why a client needs this at all
 *
 * The server allocates a gapless `seq` per channel and broadcasts each message
 * once. That does not mean a client receives them in order, or receives them at
 * all:
 *
 * - **Two paths, one message.** A sender's own message arrives twice: once as the
 *   ack of its send, once as the broadcast. Both are the same row and must render
 *   as one line.
 * - **Reconnect.** Socket.io redelivers nothing. A client that was offline for
 *   four seconds has a hole, and the only evidence is that the next seq is not
 *   the one it expected.
 * - **Cross-replica timing.** Two messages sent through two gateways in the same
 *   millisecond are ordered by their seq, not by which Redis publish landed
 *   first, so a client can genuinely see 7 before 6.
 *
 * Every one of those is the same question: *is this the next message, or is
 * something missing?* A dense sequence makes that answerable, which is the whole
 * reason the server pays for a row lock to allocate one.
 *
 * ## The rule
 *
 * A message with `seq === lastSeen + 1` is delivered. A message ahead of that is
 * **held**, not dropped -- it is real, it is just early -- and the caller is told
 * which range is missing so it can fetch it. A message at or behind `lastSeen` is
 * discarded as a duplicate. When the gap is filled, everything held that has
 * become contiguous flushes at once, in order.
 */

/** The minimum a message needs for this module to order it. */
export interface Sequenced {
  seq: number;
}

/** What is missing, inclusive at both ends. */
export interface Gap {
  fromSeq: number;
  toSeq: number;
}

export interface AcceptResult<T extends Sequenced> {
  /**
   * Messages to render now, in ascending seq, contiguous with what the caller had
   * already seen. Empty when the arrival was early or a duplicate.
   */
  delivered: T[];
  /**
   * The range the caller must fetch, or null when nothing is missing.
   *
   * Recomputed on every call rather than remembered, so a caller that ignores it
   * and calls again gets told again. A one-shot signal would be lost by any
   * client that was mid-render when it fired.
   */
  gap: Gap | null;
  /** True when the arrival was already known and was dropped. */
  duplicate: boolean;
}

/**
 * How many early messages to hold before giving up on splicing.
 *
 * The buffer is unbounded in principle and must not be in practice: a client
 * whose gap never fills -- a fetch that keeps failing, a channel it lost access
 * to mid-stream -- would otherwise accumulate every subsequent message in memory
 * forever. Past this many held messages the caller is told to reload the channel
 * instead, which is the same answer `TOO_FAR_BEHIND` gives on the server side.
 *
 * 500 is well above any real reordering window (which is bounded by a round trip)
 * and well below anything that costs memory worth caring about.
 */
export const MAX_HELD = 500;

export class ReorderBuffer<T extends Sequenced> {
  /**
   * Held messages by seq. A Map rather than an array because the keys are sparse
   * by definition -- that is what a gap is -- and an array indexed by seq would
   * allocate the hole.
   */
  private readonly held = new Map<number, T>();

  /**
   * The highest seq delivered so far. Zero means nothing, which is why the
   * server's seq counts from one: with a zero-based seq, "delivered nothing" and
   * "delivered the first message" would be the same state.
   */
  private lastSeen: number;

  constructor(lastSeen = 0) {
    if (!Number.isInteger(lastSeen) || lastSeen < 0) {
      throw new RangeError(`lastSeen must be a non-negative integer, got ${String(lastSeen)}`);
    }
    this.lastSeen = lastSeen;
  }

  /** The highest contiguous seq this buffer has delivered. */
  get position(): number {
    return this.lastSeen;
  }

  /** How many early messages are waiting for a gap to fill. */
  get heldCount(): number {
    return this.held.size;
  }

  /** True when the buffer has given up on splicing and the caller must reload. */
  get overflowed(): boolean {
    return this.held.size > MAX_HELD;
  }

  /**
   * Offer one message.
   *
   * Not `push`: the buffer decides whether this is news. The three outcomes are
   * in the returned shape rather than in an exception, because "this is a
   * duplicate" is the single most common outcome on the send path (every message
   * a client sends arrives twice) and exceptions are the wrong tool for the
   * common case.
   */
  accept(message: T): AcceptResult<T> {
    const { seq } = message;
    if (!Number.isInteger(seq) || seq < 1) {
      throw new RangeError(`seq must be a positive integer, got ${String(seq)}`);
    }

    // Behind or at the mark: already rendered. The sender's own ack-plus-broadcast
    // pair lands here, and so does a redelivery after a flaky reconnect.
    if (seq <= this.lastSeen) {
      return { delivered: [], gap: this.gap(), duplicate: true };
    }

    // Ahead, and already held: the same early message twice.
    if (this.held.has(seq)) {
      return { delivered: [], gap: this.gap(), duplicate: true };
    }

    this.held.set(seq, message);
    return { delivered: this.flush(), gap: this.gap(), duplicate: false };
  }

  /**
   * Offer many at once, as a catch-up page does.
   *
   * Sorted first, so a caller handing over an unordered fetch result gets the
   * same answer as one handing over an ordered one. Without the sort, a page
   * arriving as [9, 7, 8] would deliver 7 and 8 and hold 9 needlessly for the
   * duration of the call.
   */
  acceptAll(messages: readonly T[]): AcceptResult<T> {
    const delivered: T[] = [];
    let duplicates = 0;

    for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
      const result = this.accept(message);
      delivered.push(...result.delivered);
      if (result.duplicate) duplicates += 1;
    }

    return {
      delivered,
      gap: this.gap(),
      // Only when *everything* offered was already known. A page that filled a
      // gap and repeated one line is news, and reporting it as a duplicate would
      // make the caller discard the whole page.
      duplicate: messages.length > 0 && duplicates === messages.length,
    };
  }

  /**
   * Everything held that is now contiguous, removed from the buffer.
   *
   * The loop is what makes filling a gap cheap: receiving the single missing
   * message 6 while holding 7, 8 and 9 delivers all four in one pass, in order,
   * with no re-sorting and no second call.
   */
  private flush(): T[] {
    const out: T[] = [];
    for (;;) {
      const next = this.held.get(this.lastSeen + 1);
      if (!next) break;
      this.held.delete(this.lastSeen + 1);
      this.lastSeen += 1;
      out.push(next);
    }
    return out;
  }

  /**
   * What is missing between the mark and the lowest held message.
   *
   * Computed from state rather than tracked, so it cannot go stale. The lowest
   * held seq is found by scanning, which is O(held) -- held is bounded by
   * MAX_HELD and is empty in the overwhelmingly common case, so this is a
   * property read that costs nothing until something is actually wrong.
   */
  private gap(): Gap | null {
    if (this.held.size === 0) return null;
    let lowest = Number.POSITIVE_INFINITY;
    for (const seq of this.held.keys()) if (seq < lowest) lowest = seq;
    // Unreachable while `flush` runs after every insert -- anything contiguous is
    // gone by now -- but the guard is cheap and its absence would produce an
    // inverted range that a fetch would answer with an empty page forever.
    if (lowest <= this.lastSeen + 1) return null;
    return { fromSeq: this.lastSeen + 1, toSeq: lowest - 1 };
  }

  /**
   * Throw away every held message and jump the mark.
   *
   * What a client calls after refetching the channel: the buffer's held messages
   * are all at or below the new mark, or are about to be re-delivered by the
   * fetch, and keeping them would double-render the overlap.
   */
  reset(lastSeen: number): void {
    if (!Number.isInteger(lastSeen) || lastSeen < 0) {
      throw new RangeError(`lastSeen must be a non-negative integer, got ${String(lastSeen)}`);
    }
    this.held.clear();
    this.lastSeen = lastSeen;
  }
}

/**
 * Are these messages a complete, ordered run starting at `from`?
 *
 * The assertion the integration lane makes about what the server produced, and
 * the reason it is here rather than inline in a test: "the seqs are 1..N with no
 * duplicates and no holes" is the property the whole ordering design exists to
 * provide, and it should be stated once, in the module that owns the concept.
 */
export function isContiguousRun(messages: readonly Sequenced[], from = 1): boolean {
  const seqs = messages.map((message) => message.seq).sort((a, b) => a - b);
  return seqs.every((seq, index) => seq === from + index);
}

/**
 * The holes in a set of sequence numbers.
 *
 * Used by the integration lane to say *which* messages went missing rather than
 * merely that some did, and by the client's diagnostics. Returns ranges rather
 * than individual numbers because a gap of 400 should not be 400 objects.
 */
export function missingRanges(seqs: readonly number[], from: number, to: number): Gap[] {
  const present = new Set(seqs);
  const gaps: Gap[] = [];
  let start: number | null = null;

  for (let seq = from; seq <= to; seq += 1) {
    if (present.has(seq)) {
      if (start !== null) {
        gaps.push({ fromSeq: start, toSeq: seq - 1 });
        start = null;
      }
    } else if (start === null) {
      start = seq;
    }
  }
  if (start !== null) gaps.push({ fromSeq: start, toSeq: to });

  return gaps;
}
