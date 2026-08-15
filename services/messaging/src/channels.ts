/**
 * Creating channels, and opening a DM without creating two of them.
 */
import { can, type ChannelRole } from '@chat/shared';

import { dmKeyFor } from './dm';
import { MessagingError, type ChannelRow, type MessagingRepository } from './ports';

export interface CreateChannelInput {
  kind: 'PUBLIC' | 'PRIVATE';
  name: string;
  slug: string;
  topic?: string;
  createdById: string;
}

/**
 * Create a named channel, with its creator as OWNER.
 *
 * One transaction for both writes. A channel with no owner is unreachable state:
 * "who may delete this?" is a query over memberships, and it would have no answer
 * forever, with nothing failing to say so.
 */
export async function createChannel(
  repository: MessagingRepository,
  input: CreateChannelInput,
): Promise<ChannelRow> {
  return repository.withTransaction(async (tx) => {
    const channel = await tx.createChannel({
      kind: input.kind,
      slug: input.slug,
      name: input.name,
      topic: input.topic ?? null,
      dmKey: null,
      createdById: input.createdById,
    });
    await tx.addMember(channel.id, input.createdById, 'OWNER');
    return channel;
  });
}

export interface OpenDmResult {
  channel: ChannelRow;
  /** True when the channel already existed, whether from before or from a race. */
  existing: boolean;
}

/** A duplicate-key error the caller's adapter recognised. */
export interface DmConflictClassifier {
  isDuplicateDmKey(error: unknown): boolean;
}

/**
 * Open the DM between two people, creating it only if it does not exist.
 *
 * The read-then-create is deliberately **not** guarded by a lock, and the
 * duplicate-key error is deliberately caught rather than avoided. Two people
 * clicking "message" on each other in the same instant both read nothing and both
 * insert; the unique index on `dm_key` lets exactly one through, and the loser
 * reads the winner's row back. Both end up in one conversation.
 *
 * The alternatives are worse in specific ways:
 *
 * - **`SELECT ... FOR UPDATE` first.** There is no row to lock -- that is the
 *   case being handled -- so it locks nothing and the race is unchanged.
 * - **An advisory lock on the key.** It works and it serialises every DM open in
 *   the product behind a lock manager, to prevent a collision that happens on the
 *   order of once per pair per lifetime.
 * - **Reporting the conflict.** Technically correct and presents to whoever
 *   clicked second as "could not open conversation", for a conversation that
 *   exists.
 *
 * Both memberships are written in the same transaction as the channel, so a DM
 * cannot exist with one participant.
 */
export async function openDm(
  repository: MessagingRepository,
  a: string,
  b: string,
  classify: DmConflictClassifier,
): Promise<OpenDmResult> {
  const dmKey = dmKeyFor(a, b);

  const found = await repository.withTransaction((tx) => tx.channelByDmKey(dmKey));
  if (found) return { channel: found, existing: true };

  try {
    const channel = await repository.withTransaction(async (tx) => {
      const created = await tx.createChannel({
        kind: 'DM',
        slug: null,
        name: null,
        topic: null,
        dmKey,
        createdById: a,
      });
      // Both MEMBER, neither OWNER. Ownership would mean one of them could remove
      // the other from a conversation they are both in, and the partial unique
      // index in the invariants migration permits zero owners for exactly this.
      await tx.addMember(created.id, a, 'MEMBER');
      await tx.addMember(created.id, b, 'MEMBER');
      return created;
    });
    return { channel, existing: false };
  } catch (error) {
    if (!classify.isDuplicateDmKey(error)) throw error;

    // Lost the race. The winner's row is committed by definition -- the unique
    // index could not have rejected this insert otherwise -- so this read finds
    // it.
    const winner = await repository.withTransaction((tx) => tx.channelByDmKey(dmKey));
    if (!winner) {
      throw new MessagingError(
        'CONFLICT',
        'The direct message could not be opened. Try again.',
      );
    }
    return { channel: winner, existing: true };
  }
}

export interface AddMemberInput {
  channelId: string;
  actorId: string;
  userId: string;
  role?: ChannelRole;
}

/**
 * Add somebody to a channel.
 *
 * Refuses on a DM, and the refusal is the interesting part: a DM's identity *is*
 * its two participants, encoded in `dm_key`. A third member would make the key a
 * lie -- two people could then open a "new" DM with the same key and be given
 * this three-person channel instead.
 */
export async function addMember(
  repository: MessagingRepository,
  input: AddMemberInput,
): Promise<void> {
  await repository.withTransaction(async (tx) => {
    const channel = await tx.channel(input.channelId);
    if (!channel) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');
    if (channel.kind === 'DM') {
      throw new MessagingError(
        'INVALID',
        'A direct message is between two people. Create a channel instead.',
      );
    }

    const actor = await tx.member(input.channelId, input.actorId);
    if (!actor) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');
    // The capability, from the shared matrix rather than from a role comparison
    // here. An OWNER and an ADMIN both hold it; a MEMBER does not.
    if (!can(actor.role, 'channel.manageMembers')) {
      throw new MessagingError('FORBIDDEN', 'You cannot add people to this channel.');
    }

    const already = await tx.member(input.channelId, input.userId);
    // Idempotent. Adding somebody twice is a double-click, not an error worth
    // showing, and reporting a conflict would make the second click look like a
    // failure to add them at all.
    if (already) return;

    await tx.addMember(input.channelId, input.userId, input.role ?? 'MEMBER');
  });
}
