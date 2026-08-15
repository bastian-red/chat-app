/**
 * The client's message list, and the one operation that keeps it honest.
 *
 * A sent message exists in two states and arrives by two paths, which is where
 * every duplicated line in every chat client comes from:
 *
 * - The **optimistic** line, rendered the instant somebody presses enter. It has
 *   a `clientMessageId` and no `seq`, because only the server can allocate one.
 * - The **stored** message, which arrives either as the ack of that send or as a
 *   `message.new` broadcast. It has both.
 *
 * `reconcile` is what turns the second into a replacement for the first rather
 * than a second line beside it. It matches on `clientMessageId`, which is the
 * whole reason the client generates one before it sends: nothing else is knowable
 * on both sides of a round trip that may have failed.
 *
 * Three rules, each of which is a real case rather than defensive coding:
 *
 * 1. **A stored message replaces a pending one with the same client id.** The
 *    ordinary path.
 * 2. **A message already in the list, by seq, is dropped.** The author receives
 *    their own message twice whenever the gateway's `except(socket.id)` is
 *    bypassed -- a second tab, a rejoin mid-send, a REST send while a socket is
 *    open. Dropping is correct and silent.
 * 3. **Everything else is inserted in seq order**, not appended. A client on a
 *    slow connection can genuinely receive 7 before 6 (`docs/SPECS.md` section
 *    4.7), and appending would render the conversation out of order permanently,
 *    because nothing later re-sorts it.
 *
 * Pure, and separated from the socket for that reason: this is the logic worth
 * testing exhaustively, and it needs no network to do it.
 */
import type { Message } from '@chat/shared';

/** A line the server has not confirmed yet. */
export interface PendingMessage {
  kind: 'pending';
  clientMessageId: string;
  body: string;
  authorId: string;
  authorName: string;
  /** When the client rendered it, for the relative timestamp until the ack lands. */
  createdAt: string;
  /** Set when the send was refused, so the row can offer a retry. */
  failed?: boolean;
}

export interface StoredMessage {
  kind: 'stored';
  message: Message;
}

export type Line = PendingMessage | StoredMessage;

export const seqOf = (line: Line): number | null =>
  line.kind === 'stored' ? line.message.seq : null;

/**
 * Fold a stored message into the list.
 *
 * Returns a new array always, even when nothing changed. React's identity
 * comparison is what decides whether the conversation re-renders, and an
 * in-place mutation here is a list that updates on some renders and not others.
 */
export function reconcile(lines: readonly Line[], message: Message): Line[] {
  // Rule 2 first, and before the pending scan: a duplicate of something already
  // stored must not resurrect a pending line that was already replaced.
  if (lines.some((line) => line.kind === 'stored' && line.message.seq === message.seq)) {
    return [...lines];
  }

  const pendingIndex = lines.findIndex(
    (line) => line.kind === 'pending' && line.clientMessageId === message.clientMessageId,
  );

  if (pendingIndex !== -1) {
    // Replaced in place rather than removed and appended. The pending line is
    // already at the bottom of a conversation somebody is reading, and moving it
    // would make the text jump under them at the moment the ack lands.
    const next = [...lines];
    next[pendingIndex] = { kind: 'stored', message };
    return sortStored(next);
  }

  return sortStored([...lines, { kind: 'stored', message }]);
}

/** An update to a message already on screen: an edit, or a tombstone. */
export function replace(lines: readonly Line[], message: Message): Line[] {
  const index = lines.findIndex((line) => line.kind === 'stored' && line.message.id === message.id);
  // Not inserted when it is absent. An edit to a message this client never
  // received is a message it also cannot place: splicing it in on the strength of
  // its seq would put an hour-old line at the bottom of the conversation.
  if (index === -1) return [...lines];

  const next = [...lines];
  next[index] = { kind: 'stored', message };
  return next;
}

/** Add the optimistic line. */
export function addPending(lines: readonly Line[], pending: PendingMessage): Line[] {
  return [...lines, pending];
}

/** Mark a pending line as refused, so the row can offer a retry. */
export function markFailed(lines: readonly Line[], clientMessageId: string): Line[] {
  return lines.map((line) =>
    line.kind === 'pending' && line.clientMessageId === clientMessageId
      ? { ...line, failed: true }
      : line,
  );
}

/**
 * Stored messages in seq order, with pending lines held at the end.
 *
 * Pending lines have no seq and belong at the bottom by definition: they are the
 * newest thing the person did. Sorting them against stored messages would need an
 * ordering key they do not have, and inventing one from `createdAt` would put a
 * pending line above a message the server allocated a lower seq to, which is the
 * ordering the whole project exists to make impossible.
 */
function sortStored(lines: readonly Line[]): Line[] {
  const stored = lines.filter((line): line is StoredMessage => line.kind === 'stored');
  const pending = lines.filter((line): line is PendingMessage => line.kind === 'pending');

  stored.sort((left, right) => left.message.seq - right.message.seq);
  return [...stored, ...pending];
}

/**
 * The highest seq this list holds, or 0.
 *
 * What the reorder buffer and `channel.catchup` are anchored to. Zero for an empty
 * conversation rather than -1 or null, because `lastReadSeq` counts from zero and
 * "I have nothing" and "I have message 1" have to be different numbers.
 */
export function highestSeq(lines: readonly Line[]): number {
  let highest = 0;
  for (const line of lines) {
    if (line.kind === 'stored' && line.message.seq > highest) highest = line.message.seq;
  }
  return highest;
}

/**
 * Whether the list has a hole in it.
 *
 * Returns the first missing seq, or null. The client asks for a catch-up from
 * `first - 1` when this is non-null, which is what repairs a reconnect that
 * dropped frames. Recomputed on every call rather than remembered, so a caller
 * that ignored the answer once gets told again.
 */
export function firstGap(lines: readonly Line[]): number | null {
  const seqs = lines
    .filter((line): line is StoredMessage => line.kind === 'stored')
    .map((line) => line.message.seq)
    .sort((a, b) => a - b);

  for (let index = 1; index < seqs.length; index += 1) {
    const previous = seqs[index - 1]!;
    const current = seqs[index]!;
    if (current !== previous + 1) return previous + 1;
  }
  return null;
}
