/**
 * The write path: send, edit, delete, mark read.
 *
 * Every function here takes a repository and returns a row. None of them knows
 * about HTTP, about sockets, or about broadcasting -- the two callers do that,
 * and they do it the same way because `packages/shared/src/broadcast.ts` owns the
 * mapping from a row to a wire payload.
 *
 * The three properties this module exists to hold, each with the mechanism that
 * holds it:
 *
 * 1. **One total order per channel, with no gaps.** `tx.allocateSeq` is a single
 *    `UPDATE ... RETURNING`, which takes a row lock, so concurrent senders queue.
 *    The allocation and the insert are in one transaction, so a crash between
 *    them rolls the number back rather than burning it.
 * 2. **A resend is not a second message.** The insert is optimistic and the
 *    unique violation on `(channel_id, client_message_id)` is *caught*, not
 *    avoided: checking first and inserting second is a race that loses exactly
 *    when it matters, which is two tabs retrying one failed send at once.
 * 3. **Nobody writes into a channel they are not in.** The membership read and
 *    the permission check happen inside the same transaction as the write, so a
 *    member removed a millisecond earlier cannot slip a message through the gap
 *    between the check and the insert.
 */
import { can, canActOnMessage } from '@chat/shared';

import { mentionsIn } from './mentions';
import {
  MessagingError,
  type MessageRow,
  type MessagingRepository,
  type MessagingTx,
} from './ports';

export interface SendInput {
  channelId: string;
  authorId: string;
  clientMessageId: string;
  body: string;
  attachmentIds?: string[];
}

export interface SendResult {
  message: MessageRow;
  /**
   * True when this send had already happened and the stored row was returned.
   *
   * Surfaced rather than hidden, because the two cases mean different things to a
   * client: a fresh message is a line to render, a duplicate is confirmation that
   * the optimistic line it is already showing is real. Without the flag those are
   * the same answer and the client cannot reconcile.
   */
  duplicate: boolean;
  /** Members other than the author, for the broadcast's user-room fan-out. */
  recipients: string[];
}

/**
 * How many times to replay a send whose sequence allocation collided.
 *
 * Should always be zero retries in practice: the row lock serialises allocation,
 * so two senders cannot receive the same number. It exists because "should never"
 * is not an invariant, and because a serialization failure under a stricter
 * isolation level is a real Postgres behaviour that is correct to retry.
 */
export const DEFAULT_SEND_ATTEMPTS = 5;

/** A duplicate-key error the caller's adapter recognised. */
export interface ConflictClassifier {
  isDuplicateClientMessage(error: unknown): boolean;
  isSeqCollision(error: unknown): boolean;
}

export interface SendOptions {
  attempts?: number;
  classify: ConflictClassifier;
  now?: () => Date;
}

/**
 * Send a message.
 *
 * The order of operations inside the transaction is load-bearing and is worth
 * reading as a sequence:
 *
 *   1. read the channel and the sender's membership -- inside the transaction, so
 *      a concurrent removal is either fully before or fully after this send;
 *   2. check the permission from the shared matrix;
 *   3. resolve mentions against the membership, not against every user;
 *   4. allocate the seq, taking the row lock;
 *   5. insert.
 *
 * Steps 4 and 5 are adjacent and last on purpose. Every read that could fail
 * happens before the lock is taken, so the lock is held for one insert rather
 * than for a round of validation -- which is the difference between senders
 * queueing for a millisecond and queueing for the length of the slowest query in
 * the function.
 */
export async function sendMessage(
  repository: MessagingRepository,
  input: SendInput,
  options: SendOptions,
): Promise<SendResult> {
  const attempts = options.attempts ?? DEFAULT_SEND_ATTEMPTS;
  if (attempts < 1) throw new RangeError('attempts must be at least 1');

  let lastError: unknown = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await repository.withTransaction(async (tx) => {
        const { member, members } = await requireMembership(tx, input.channelId, input.authorId);
        if (!can(member.role, 'message.send')) {
          throw new MessagingError('FORBIDDEN', 'You cannot post in this channel.');
        }

        const mentions = mentionsIn(input.body, members, input.authorId);
        const seq = await tx.allocateSeq(input.channelId);

        const message = await tx.insertMessage({
          channelId: input.channelId,
          seq,
          authorId: input.authorId,
          clientMessageId: input.clientMessageId,
          body: input.body,
          attachmentIds: input.attachmentIds ?? [],
          mentions,
        });

        return {
          message,
          duplicate: false,
          recipients: members
            .filter((entry) => entry.userId !== input.authorId)
            .map((entry) => entry.userId),
        };
      });
    } catch (error) {
      // The resend. Not a failure: read the original back and answer with it, so
      // the client's second attempt gets the same id, the same seq and the same
      // body as the first.
      //
      // Note what is NOT retried here -- the seq allocated by the failed attempt
      // is rolled back with its transaction, so nothing is burned. That is the
      // whole reason the allocation is inside the transaction rather than before
      // it.
      if (options.classify.isDuplicateClientMessage(error)) {
        const existing = await repository.withTransaction((tx) =>
          tx.messageByClientId(input.channelId, input.clientMessageId),
        );
        if (existing) {
          const members = await repository.members(input.channelId);
          return {
            message: existing,
            duplicate: true,
            recipients: members
              .filter((entry) => entry.userId !== input.authorId)
              .map((entry) => entry.userId),
          };
        }
        // The row that caused the violation is not there. Reachable only if it
        // was deleted between the insert and this read, which is a real
        // interleaving under a moderator's delete; fall through and retry.
      }

      if (options.classify.isSeqCollision(error)) {
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  // Not `throw lastError`. Its message is a Postgres constraint name, and the
  // caller's job is to tell a person that the message did not send -- but it is
  // attached as `cause` so a log has the real reason rather than only this
  // summary.
  const exhausted = new MessagingError(
    'CONFLICT',
    `Could not allocate a sequence number after ${String(attempts)} attempts.`,
  );
  exhausted.cause = lastError;
  throw exhausted;
}

export interface EditInput {
  channelId: string;
  messageId: string;
  actorId: string;
  body: string;
}

/**
 * Edit a message's body.
 *
 * The seq does not change, and that is the point: editing is not re-sending. A
 * client that already has this message replaces its body in place, everybody's
 * ordering is untouched, and nobody's gap detector sees anything.
 */
export async function editMessage(
  repository: MessagingRepository,
  input: EditInput,
  now: () => Date = () => new Date(),
): Promise<MessageRow> {
  return repository.withTransaction(async (tx) => {
    const { member } = await requireMembership(tx, input.channelId, input.actorId);
    const message = await requireMessage(tx, input.channelId, input.messageId);

    if (message.deletedAt !== null) {
      throw new MessagingError('NOT_FOUND', 'That message was deleted.');
    }
    if (!canActOnMessage(member.role, 'edit', input.actorId, message.authorId)) {
      throw new MessagingError('FORBIDDEN', 'You cannot edit that message.');
    }

    return tx.updateMessageBody(input.messageId, input.body, now());
  });
}

export interface DeleteInput {
  channelId: string;
  messageId: string;
  actorId: string;
}

/**
 * Delete a message, as a tombstone.
 *
 * Soft, always. A hard delete removes a seq from the middle of the sequence, and
 * a hole is indistinguishable from a message a client has not received yet -- so
 * every reader would ask for the missing number forever and never be given it.
 * The row keeps its seq and loses its body.
 *
 * Idempotent: deleting an already-deleted message returns the tombstone rather
 * than failing. Two moderators clicking at once is not an error worth reporting
 * to either of them.
 */
export async function deleteMessage(
  repository: MessagingRepository,
  input: DeleteInput,
  now: () => Date = () => new Date(),
): Promise<MessageRow> {
  return repository.withTransaction(async (tx) => {
    const { member } = await requireMembership(tx, input.channelId, input.actorId);
    const message = await requireMessage(tx, input.channelId, input.messageId);

    if (!canActOnMessage(member.role, 'delete', input.actorId, message.authorId)) {
      throw new MessagingError('FORBIDDEN', 'You cannot delete that message.');
    }
    if (message.deletedAt !== null) return message;

    return tx.softDeleteMessage(input.messageId, now());
  });
}

export interface MarkReadInput {
  channelId: string;
  userId: string;
  seq: number;
}

/**
 * Move a read marker forward.
 *
 * Returns what the marker **is**, not what was asked for. The adapter's SQL only
 * moves it forward, so a stale request from a second tab is a no-op rather than a
 * rollback, and the caller learns the real value instead of the one it sent --
 * which is what lets a client that lost the race correct itself without a
 * refetch.
 *
 * A marker beyond the end of the channel is clamped rather than rejected. It is
 * reachable without any bug: a client marks up to the last message it rendered,
 * and a moderator's delete can lower nothing but a race with a rollback can leave
 * the client one ahead. Storing it would make the unread count negative.
 */
export async function markRead(
  repository: MessagingRepository,
  input: MarkReadInput,
): Promise<number> {
  return repository.withTransaction(async (tx) => {
    const channel = await tx.channel(input.channelId);
    if (!channel) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');

    const member = await tx.member(input.channelId, input.userId);
    if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');

    const highest = channel.nextSeq - 1;
    return tx.advanceReadMarker(input.channelId, input.userId, Math.min(input.seq, highest));
  });
}

/**
 * The unread count for a member: how many messages exist that they have not read.
 *
 * Computed, never stored. Storing it means two writers for one fact -- the send
 * path and the read path -- and every unread-counter bug in every chat product is
 * those two disagreeing. `nextSeq - 1` is the highest seq in use, so the count is
 * that minus the marker.
 *
 * Clamped at zero because a marker can legitimately sit at the highest seq, and a
 * negative badge is worse than a wrong one.
 */
export function unreadCount(nextSeq: number, lastReadSeq: number): number {
  return Math.max(0, nextSeq - 1 - lastReadSeq);
}

async function requireMembership(
  tx: MessagingTx,
  channelId: string,
  userId: string,
): Promise<{ member: NonNullable<Awaited<ReturnType<MessagingTx['member']>>>; members: Awaited<ReturnType<MessagingTx['members']>> }> {
  const channel = await tx.channel(channelId);
  if (!channel) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');

  const member = await tx.member(channelId, userId);
  // The same answer for "not a member" and "no such channel" would leak the
  // existence of every private channel to anybody who could guess an id.
  if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');

  return { member, members: await tx.members(channelId) };
}

async function requireMessage(
  tx: MessagingTx,
  channelId: string,
  messageId: string,
): Promise<MessageRow> {
  const message = await tx.message(messageId);
  // The channel check is not redundant. Without it, a member of channel A could
  // edit a message in channel B by passing B's message id with A's channel id --
  // the membership check above would pass against A, and the write would land in
  // B.
  if (!message || message.channelId !== channelId) {
    throw new MessagingError('NOT_FOUND', 'That message does not exist.');
  }
  return message;
}
