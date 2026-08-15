/**
 * The client's reconciliation, which is where duplicated lines come from.
 *
 * Every case here is a real arrival pattern rather than a defensive one. The
 * conversation is the product, and the failure modes are all cosmetic-looking and
 * all permanent: a line rendered twice stays twice, a line inserted at the bottom
 * stays at the bottom, and nothing in the app re-sorts later.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '@chat/shared';

import {
  addPending,
  firstGap,
  highestSeq,
  markFailed,
  reconcile,
  replace,
  type Line,
  type PendingMessage,
} from './reconcile';

function stored(
  seq: number,
  clientMessageId = `c-${String(seq)}`,
  body = `line ${String(seq)}`,
): Message {
  return {
    id: `m-${String(seq)}`,
    channelId: 'c1',
    seq,
    author: { id: 'u-ana', name: 'Ana Ruiz', initials: 'AR' },
    clientMessageId,
    body,
    createdAt: '2026-08-10T09:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    attachments: [],
    mentions: [],
  };
}

function pending(clientMessageId: string, body = 'typed just now'): PendingMessage {
  return {
    kind: 'pending',
    clientMessageId,
    body,
    authorId: 'u-ana',
    authorName: 'Ana Ruiz',
    createdAt: '2026-08-10T09:00:00.000Z',
  };
}

const seqs = (lines: Line[]): (number | null)[] =>
  lines.map((line) => (line.kind === 'stored' ? line.message.seq : null));

describe('reconcile', () => {
  it('replaces the optimistic line rather than adding a second one', () => {
    // The ordinary path, and the one that produces a doubled message when it is
    // wrong. Matching on `clientMessageId` is the only thing knowable on both
    // sides of a round trip that may have failed.
    const lines = addPending([], pending('c-1'));

    const next = reconcile(lines, stored(1, 'c-1'));

    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe('stored');
  });

  it('keeps the replacement in the position the pending line held', () => {
    // The pending line is at the bottom of a conversation somebody is reading.
    // Removing and appending would be the same set and would make the text jump
    // under them at the instant the ack lands.
    let lines: Line[] = [{ kind: 'stored', message: stored(1) }];
    lines = addPending(lines, pending('c-2'));

    const next = reconcile(lines, stored(2, 'c-2'));

    expect(seqs(next)).toEqual([1, 2]);
  });

  it('drops a message it already has, by seq', () => {
    // The author receives their own message twice whenever the gateway's
    // `except(socket.id)` is bypassed: a second tab, a rejoin mid-send, a REST
    // send while a socket is open. Dropping is correct and silent.
    const lines: Line[] = [{ kind: 'stored', message: stored(1) }];

    const next = reconcile(lines, stored(1));

    expect(next).toHaveLength(1);
  });

  it('does not resurrect a pending line when a duplicate arrives', () => {
    // The ordering inside `reconcile`. If the pending scan ran first, a duplicate
    // of an already-replaced message would find nothing, fall through, and be
    // inserted as a second copy.
    let lines = addPending([], pending('c-1'));
    lines = reconcile(lines, stored(1, 'c-1'));

    const next = reconcile(lines, stored(1, 'c-1'));

    expect(next).toHaveLength(1);
  });

  it('inserts out-of-order arrivals in seq order rather than appending', () => {
    // A client can genuinely receive 7 before 6: two messages sent through two
    // gateways in the same millisecond are ordered by seq, not by which Redis
    // publish landed first. Appending would render the conversation permanently
    // out of order, because nothing later re-sorts it.
    let lines: Line[] = [];
    for (const seq of [3, 1, 2]) lines = reconcile(lines, stored(seq));

    expect(seqs(lines)).toEqual([1, 2, 3]);
  });

  it('keeps pending lines below every stored one', () => {
    // Pending lines have no seq. Ordering them against stored messages would need
    // a key they do not have, and deriving one from `createdAt` would put a
    // pending line above a message the server gave a lower seq, which is the
    // ordering this project exists to make impossible.
    let lines: Line[] = [];
    lines = addPending(lines, pending('c-9'));
    lines = reconcile(lines, stored(5));

    expect(seqs(lines)).toEqual([5, null]);
  });

  it('returns a new array even when nothing changed', () => {
    // React's identity comparison is what decides whether the conversation
    // re-renders. An in-place mutation is a list that updates on some renders and
    // not others, which reads as a flaky socket.
    const lines: Line[] = [{ kind: 'stored', message: stored(1) }];

    expect(reconcile(lines, stored(1))).not.toBe(lines);
  });

  it('does not touch an unrelated pending line', () => {
    let lines = addPending([], pending('c-mine'));
    lines = reconcile(lines, stored(4, 'c-somebody-else'));

    expect(lines.some((line) => line.kind === 'pending' && line.clientMessageId === 'c-mine')).toBe(
      true,
    );
  });
});

describe('replace', () => {
  it('swaps an edited message in place', () => {
    const lines: Line[] = [
      { kind: 'stored', message: stored(1) },
      { kind: 'stored', message: stored(2) },
    ];

    const edited = { ...stored(1), body: 'edited', editedAt: '2026-08-10T10:00:00.000Z' };
    const next = replace(lines, edited);

    expect(next[0]).toMatchObject({ kind: 'stored', message: { body: 'edited' } });
    expect(seqs(next)).toEqual([1, 2]);
  });

  it('renders a tombstone in place rather than removing the line', () => {
    // The row keeps its seq and loses its body. Removing it would put a hole in
    // the sequence from the client's point of view, and a hole is what triggers a
    // catch-up that can never be satisfied.
    const lines: Line[] = [{ kind: 'stored', message: stored(1) }];

    const next = replace(lines, {
      ...stored(1),
      body: '',
      deletedAt: '2026-08-10T10:00:00.000Z',
    });

    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ message: { deletedAt: '2026-08-10T10:00:00.000Z' } });
  });

  it('ignores an edit to a message this client never received', () => {
    // Splicing it in on the strength of its seq would put an hour-old line at the
    // bottom of the conversation.
    const lines: Line[] = [{ kind: 'stored', message: stored(1) }];

    expect(replace(lines, stored(99))).toHaveLength(1);
  });
});

describe('markFailed', () => {
  it('marks only the line that was refused', () => {
    let lines = addPending([], pending('c-1'));
    lines = addPending(lines, pending('c-2'));

    const next = markFailed(lines, 'c-1');

    expect(next[0]).toMatchObject({ clientMessageId: 'c-1', failed: true });
    expect(next[1]).not.toHaveProperty('failed', true);
  });
});

describe('highestSeq', () => {
  it('is zero for an empty conversation', () => {
    // Zero and not -1 or null: `lastReadSeq` counts from zero, and "I have
    // nothing" and "I have message 1" have to be different numbers.
    expect(highestSeq([])).toBe(0);
  });

  it('ignores pending lines, which have no seq to be highest', () => {
    const lines = addPending([{ kind: 'stored', message: stored(7) }], pending('c-8'));

    expect(highestSeq(lines)).toBe(7);
  });

  it('is the maximum, not the last element', () => {
    const lines: Line[] = [
      { kind: 'stored', message: stored(9) },
      { kind: 'stored', message: stored(4) },
    ];

    expect(highestSeq(lines)).toBe(9);
  });
});

describe('firstGap', () => {
  it('is null for a contiguous conversation', () => {
    let lines: Line[] = [];
    for (const seq of [1, 2, 3]) lines = reconcile(lines, stored(seq));

    expect(firstGap(lines)).toBeNull();
  });

  it('is null for a single message, however high its seq', () => {
    // A client that joined mid-conversation holds one page starting at seq 41.
    // Reporting a gap of 1..40 there would make every join ask for a catch-up of
    // the whole channel, which is the reconnect storm the bound exists to prevent.
    expect(firstGap([{ kind: 'stored', message: stored(41) }])).toBeNull();
  });

  it('reports the first missing seq, not the size of the hole', () => {
    let lines: Line[] = [];
    for (const seq of [1, 2, 5, 6]) lines = reconcile(lines, stored(seq));

    expect(firstGap(lines)).toBe(3);
  });

  it('reports the earliest hole when there are two', () => {
    let lines: Line[] = [];
    for (const seq of [1, 3, 5]) lines = reconcile(lines, stored(seq));

    expect(firstGap(lines)).toBe(2);
  });

  it('is recomputed rather than remembered', () => {
    // A caller that ignored the answer once gets told again, which is what makes
    // a failed catch-up recoverable instead of a hole that persists until reload.
    let lines: Line[] = [];
    for (const seq of [1, 3]) lines = reconcile(lines, stored(seq));
    expect(firstGap(lines)).toBe(2);

    lines = reconcile(lines, stored(2));
    expect(firstGap(lines)).toBeNull();
  });

  it('ignores pending lines', () => {
    let lines: Line[] = [];
    for (const seq of [1, 2]) lines = reconcile(lines, stored(seq));
    lines = addPending(lines, pending('c-next'));

    expect(firstGap(lines)).toBeNull();
  });
});
