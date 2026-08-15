/**
 * An in-memory `MessagingRepository`, for the gate lane.
 *
 * **This is not a mock.** Nothing here returns a canned answer or records a call:
 * it is a real implementation over Maps, with the same semantics the Postgres
 * adapter has, and the functions under test cannot tell the difference. That
 * distinction is the reason the gate lane is worth anything -- a mocked
 * `allocateSeq` would let `sendMessage` pass with the allocation outside the
 * transaction, which is the exact bug the design exists to prevent.
 *
 * What it deliberately does **not** simulate is concurrency. JavaScript is single
 * threaded and these Maps are not a database, so "two senders race for a seq" is
 * unrepresentable here and is proved in `apps/api/test/concurrency.integration.test.ts`
 * against real Postgres. What it can do is the other half: every permission
 * branch, the idempotency path, read-marker monotonicity, mention resolution, the
 * DM key -- all in milliseconds, with no container.
 *
 * It is shipped rather than confined to a test file because two packages need it:
 * this service's own suite and the API's unit tests.
 */
import type { ChannelKind, ChannelRole } from '@chat/shared';

import type {
  AttachmentRow,
  ChannelRow,
  ForwardQuery,
  HistoryQuery,
  MemberRow,
  MessageRow,
  MessagingRepository,
  MessagingTx,
  NewChannel,
  NewMessage,
} from './ports';

/** The duplicate-key errors the real adapter classifies, as plain objects. */
export class FakeUniqueViolation extends Error {
  constructor(readonly constraint: 'client_message_id' | 'seq' | 'dm_key') {
    super(`duplicate key value violates unique constraint (${constraint})`);
    this.name = 'FakeUniqueViolation';
  }
}

export const fakeClassifier = {
  isDuplicateClientMessage: (error: unknown): boolean =>
    error instanceof FakeUniqueViolation && error.constraint === 'client_message_id',
  isSeqCollision: (error: unknown): boolean =>
    error instanceof FakeUniqueViolation && error.constraint === 'seq',
  isDuplicateDmKey: (error: unknown): boolean =>
    error instanceof FakeUniqueViolation && error.constraint === 'dm_key',
};

interface UserRecord {
  id: string;
  name: string;
  email: string;
}

export interface SeedChannel {
  id: string;
  kind?: ChannelKind;
  slug?: string | null;
  name?: string | null;
  dmKey?: string | null;
  members: { userId: string; role?: ChannelRole; lastReadSeq?: number }[];
}

export class InMemoryMessagingRepository implements MessagingRepository {
  private readonly channels = new Map<string, ChannelRow>();
  private readonly membersByChannel = new Map<string, Map<string, MemberRow>>();
  private readonly messages: MessageRow[] = [];
  private readonly users = new Map<string, UserRecord>();
  private readonly attachments = new Map<string, AttachmentRow>();
  private counter = 0;

  /**
   * How many transactions have been opened.
   *
   * Asserted by the tests that care that the allocation and the insert are in one
   * unit of work: a `sendMessage` that opened two would be a `sendMessage` that
   * can burn a sequence number if it dies between them.
   */
  transactions = 0;

  /**
   * Called just after a seq is allocated and before the insert.
   *
   * The seam that makes an otherwise unrepresentable interleaving testable: a
   * test can insert a conflicting row here to make the following insert fail with
   * a duplicate-key error, which is what a concurrent sender would have done.
   */
  onAllocate: ((channelId: string, seq: number) => void | Promise<void>) | null = null;

  user(id: string, name: string, email = `${id}@chat.local`): this {
    this.users.set(id, { id, name, email });
    return this;
  }

  seedChannel(seed: SeedChannel): this {
    const now = new Date('2026-08-11T09:00:00.000Z');
    this.channels.set(seed.id, {
      id: seed.id,
      kind: seed.kind ?? 'PUBLIC',
      slug: seed.slug ?? (seed.kind === 'DM' ? null : seed.id),
      name: seed.name ?? (seed.kind === 'DM' ? null : seed.id),
      topic: null,
      nextSeq: 1,
      dmKey: seed.dmKey ?? null,
      createdById: seed.members[0]?.userId ?? null,
      createdAt: now,
      updatedAt: now,
    });

    const members = new Map<string, MemberRow>();
    for (const member of seed.members) {
      const user = this.users.get(member.userId) ?? {
        id: member.userId,
        name: member.userId,
        email: `${member.userId}@chat.local`,
      };
      this.users.set(user.id, user);
      members.set(member.userId, {
        channelId: seed.id,
        userId: member.userId,
        name: user.name,
        email: user.email,
        role: member.role ?? 'MEMBER',
        lastReadSeq: member.lastReadSeq ?? 0,
        joinedAt: now,
      });
    }
    this.membersByChannel.set(seed.id, members);
    return this;
  }

  attachment(row: AttachmentRow): this {
    this.attachments.set(row.id, row);
    return this;
  }

  /** Every message in a channel, ascending. For assertions, not for the service. */
  all(channelId: string): MessageRow[] {
    return this.messages
      .filter((message) => message.channelId === channelId)
      .sort((a, b) => a.seq - b.seq);
  }

  private id(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter).padStart(4, '0')}`;
  }

  async withTransaction<T>(work: (tx: MessagingTx) => Promise<T>): Promise<T> {
    this.transactions += 1;
    // No rollback. Modelling it would mean snapshotting every Map on entry, and
    // the functions under test do not depend on rollback for correctness -- they
    // depend on the allocation and the insert being in the *same* transaction,
    // which `transactions` above is what asserts. The real rollback behaviour is
    // Postgres's and is covered by the integration lane.
    return work(this.tx());
  }

  private tx(): MessagingTx {
    return {
      channel: (channelId) => this.channel(channelId),
      channelByDmKey: async (dmKey) =>
        [...this.channels.values()].find((channel) => channel.dmKey === dmKey) ?? null,
      member: (channelId, userId) => this.member(channelId, userId),
      members: (channelId) => this.members(channelId),

      allocateSeq: async (channelId) => {
        const channel = this.channels.get(channelId);
        if (!channel) throw new Error(`No channel ${channelId}`);
        const seq = channel.nextSeq;
        channel.nextSeq += 1;
        await this.onAllocate?.(channelId, seq);
        return seq;
      },

      insertMessage: async (input: NewMessage) => {
        const clash = this.messages.find(
          (message) =>
            message.channelId === input.channelId &&
            message.clientMessageId === input.clientMessageId,
        );
        if (clash) throw new FakeUniqueViolation('client_message_id');

        const seqClash = this.messages.find(
          (message) => message.channelId === input.channelId && message.seq === input.seq,
        );
        if (seqClash) throw new FakeUniqueViolation('seq');

        const author = input.authorId ? this.users.get(input.authorId) : undefined;
        const row: MessageRow = {
          id: this.id('m'),
          channelId: input.channelId,
          seq: input.seq,
          authorId: input.authorId,
          authorName: author?.name ?? null,
          clientMessageId: input.clientMessageId,
          body: input.body,
          editedAt: null,
          deletedAt: null,
          createdAt: new Date('2026-08-11T09:00:00.000Z'),
          attachments: input.attachmentIds
            .map((id) => this.attachments.get(id))
            .filter((entry): entry is AttachmentRow => entry !== undefined),
          mentions: [...input.mentions],
        };
        this.messages.push(row);
        return row;
      },

      messageByClientId: async (channelId, clientMessageId) =>
        this.messages.find(
          (message) =>
            message.channelId === channelId && message.clientMessageId === clientMessageId,
        ) ?? null,

      message: async (messageId) =>
        this.messages.find((message) => message.id === messageId) ?? null,

      updateMessageBody: async (messageId, body, editedAt) => {
        const message = this.messages.find((entry) => entry.id === messageId);
        if (!message) throw new Error(`No message ${messageId}`);
        message.body = body;
        message.editedAt = editedAt;
        return message;
      },

      softDeleteMessage: async (messageId, deletedAt) => {
        const message = this.messages.find((entry) => entry.id === messageId);
        if (!message) throw new Error(`No message ${messageId}`);
        // The tombstone: the row and its seq survive, the body does not. A hard
        // delete here would leave a hole every client chases forever.
        message.deletedAt = deletedAt;
        message.body = '';
        message.attachments = [];
        return message;
      },

      advanceReadMarker: async (channelId, userId, seq) => {
        const member = this.membersByChannel.get(channelId)?.get(userId);
        if (!member) throw new Error(`No member ${userId} in ${channelId}`);
        // Monotonic, exactly like the adapter's `WHERE last_read_seq < $2`.
        if (seq > member.lastReadSeq) member.lastReadSeq = seq;
        return member.lastReadSeq;
      },

      createChannel: async (input: NewChannel) => {
        if (input.dmKey !== null) {
          const clash = [...this.channels.values()].find(
            (channel) => channel.dmKey === input.dmKey,
          );
          if (clash) throw new FakeUniqueViolation('dm_key');
        }
        const now = new Date('2026-08-11T09:00:00.000Z');
        const row: ChannelRow = {
          id: this.id('c'),
          kind: input.kind,
          slug: input.slug,
          name: input.name,
          topic: input.topic,
          nextSeq: 1,
          dmKey: input.dmKey,
          createdById: input.createdById,
          createdAt: now,
          updatedAt: now,
        };
        this.channels.set(row.id, row);
        this.membersByChannel.set(row.id, new Map());
        return row;
      },

      addMember: async (channelId, userId, role) => {
        const members = this.membersByChannel.get(channelId);
        if (!members) throw new Error(`No channel ${channelId}`);
        const user = this.users.get(userId) ?? {
          id: userId,
          name: userId,
          email: `${userId}@chat.local`,
        };
        this.users.set(user.id, user);
        const row: MemberRow = {
          channelId,
          userId,
          name: user.name,
          email: user.email,
          role,
          lastReadSeq: 0,
          joinedAt: new Date('2026-08-11T09:00:00.000Z'),
        };
        members.set(userId, row);
        return row;
      },
    };
  }

  async channel(channelId: string): Promise<ChannelRow | null> {
    return this.channels.get(channelId) ?? null;
  }

  async channelBySlug(slug: string): Promise<ChannelRow | null> {
    return [...this.channels.values()].find((channel) => channel.slug === slug) ?? null;
  }

  async member(channelId: string, userId: string): Promise<MemberRow | null> {
    return this.membersByChannel.get(channelId)?.get(userId) ?? null;
  }

  async members(channelId: string): Promise<MemberRow[]> {
    return [...(this.membersByChannel.get(channelId)?.values() ?? [])];
  }

  async history(query: HistoryQuery): Promise<MessageRow[]> {
    const before = query.beforeSeq ?? Number.POSITIVE_INFINITY;
    return this.messages
      .filter((message) => message.channelId === query.channelId && message.seq < before)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, query.limit);
  }

  async forward(query: ForwardQuery): Promise<MessageRow[]> {
    return this.messages
      .filter((message) => message.channelId === query.channelId && message.seq > query.afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, query.limit);
  }

  async channelsFor(userId: string): Promise<{ channel: ChannelRow; member: MemberRow }[]> {
    const out: { channel: ChannelRow; member: MemberRow }[] = [];
    for (const [channelId, members] of this.membersByChannel) {
      const member = members.get(userId);
      const channel = this.channels.get(channelId);
      if (member && channel) out.push({ channel, member });
    }
    return out;
  }

  async counterparts(channelId: string, userId: string): Promise<MemberRow[]> {
    return (await this.members(channelId)).filter((member) => member.userId !== userId);
  }

  async unreadMentions(channelId: string, userId: string, afterSeq: number): Promise<number> {
    return this.messages.filter(
      (message) =>
        message.channelId === channelId &&
        message.seq > afterSeq &&
        message.deletedAt === null &&
        message.mentions.includes(userId),
    ).length;
  }
}
