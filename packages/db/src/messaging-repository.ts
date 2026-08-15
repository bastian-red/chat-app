/**
 * The Prisma adapter for `services/messaging`'s ports.
 *
 * `services/messaging` deliberately imports no Prisma: its permission branches,
 * its idempotency path and its read-marker monotonicity are exhaustively tested
 * against an in-memory repository in the gate lane, in milliseconds, with no
 * container. This package is the other implementation of the same interface, and
 * it is the one that runs in production.
 *
 * It lives in its own package rather than inside `apps/api` or `apps/realtime`
 * because **both** of those processes call the write path directly -- that is the
 * architectural decision the whole project rests on (a socket send costs one hop,
 * not two). An adapter that lived in one app would have to be imported across an
 * app boundary by the other, or written twice.
 *
 * ---------------------------------------------------------------------------
 * BIGINT, and why it is narrowed here rather than carried
 *
 * `seq`, `next_seq` and `last_read_seq` are BIGINT in Postgres and arrive from
 * Prisma as `bigint`. The wire type is a JSON number, on purpose: 2^53 messages in
 * one channel is 285,000 years at one message per second, and a string seq would
 * turn every client-side `seq > lastSeen` into a BigInt parse in the hot path of
 * rendering a conversation.
 *
 * So the narrowing happens once, here, at the boundary -- and it **throws** rather
 * than truncating. `Number(9007199254740993n)` is `9007199254740992`, silently, and
 * two messages that disagree about their own position is the exact failure this
 * project exists to make impossible. A loud error 285,000 years early is the
 * better trade.
 */
import type { Prisma, PrismaClient } from '../generated/client';
import {
  type AttachmentRow,
  type ChannelRow,
  type ForwardQuery,
  type HistoryQuery,
  type MemberRow,
  type MessageRow,
  type MessagingRepository,
  type MessagingTx,
  type NewChannel,
  type NewMessage,
} from '@chat/messaging';
import type { ChannelKind, ChannelRole } from '@chat/shared';

/**
 * A BIGINT column as a JavaScript number.
 *
 * Exported because the seed and the integration harness narrow the same columns
 * and must do it the same way; a second `Number(...)` somewhere else is a second
 * place for the silent truncation to live.
 */
export function narrowSeq(value: bigint | number, column: string): number {
  const asNumber = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(asNumber)) {
    throw new RangeError(
      `${column} is ${String(value)}, which is beyond Number.MAX_SAFE_INTEGER. ` +
        'Narrowing it would silently change the value, and two messages that ' +
        'disagree about their own seq is unrecoverable.',
    );
  }
  return asNumber;
}

/** The row shapes Prisma is asked for, so a `select` change is a compile error. */
const CHANNEL_SELECT = {
  id: true,
  kind: true,
  slug: true,
  name: true,
  topic: true,
  nextSeq: true,
  dmKey: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

const MEMBER_SELECT = {
  channelId: true,
  userId: true,
  role: true,
  lastReadSeq: true,
  joinedAt: true,
  user: { select: { name: true, email: true } },
} as const;

const MESSAGE_SELECT = {
  id: true,
  channelId: true,
  seq: true,
  authorId: true,
  clientMessageId: true,
  body: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
  author: { select: { name: true } },
  attachments: {
    select: {
      id: true,
      filename: true,
      contentType: true,
      byteSize: true,
      storageKey: true,
    },
  },
  mentions: { select: { userId: true } },
} as const;

type RawChannel = {
  id: string;
  kind: ChannelKind;
  slug: string | null;
  name: string | null;
  topic: string | null;
  nextSeq: bigint;
  dmKey: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type RawMember = {
  channelId: string;
  userId: string;
  role: ChannelRole;
  lastReadSeq: bigint;
  joinedAt: Date;
  user: { name: string; email: string };
};

type RawMessage = {
  id: string;
  channelId: string;
  seq: bigint;
  authorId: string | null;
  clientMessageId: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  author: { name: string } | null;
  attachments: AttachmentRow[];
  mentions: { userId: string }[];
};

const toChannel = (row: RawChannel): ChannelRow => ({
  id: row.id,
  kind: row.kind,
  slug: row.slug,
  name: row.name,
  topic: row.topic,
  nextSeq: narrowSeq(row.nextSeq, 'channels.next_seq'),
  dmKey: row.dmKey,
  createdById: row.createdById,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toMember = (row: RawMember): MemberRow => ({
  channelId: row.channelId,
  userId: row.userId,
  name: row.user.name,
  email: row.user.email,
  role: row.role,
  lastReadSeq: narrowSeq(row.lastReadSeq, 'channel_members.last_read_seq'),
  joinedAt: row.joinedAt,
});

const toMessage = (row: RawMessage): MessageRow => ({
  id: row.id,
  channelId: row.channelId,
  seq: narrowSeq(row.seq, 'messages.seq'),
  authorId: row.authorId,
  // Flattened here so `MessageRow` stays a row rather than a tree. The presenter
  // in `services/messaging` turns it into the contract's nested author.
  authorName: row.author?.name ?? null,
  clientMessageId: row.clientMessageId,
  body: row.body,
  editedAt: row.editedAt,
  deletedAt: row.deletedAt,
  createdAt: row.createdAt,
  attachments: row.attachments,
  mentions: row.mentions.map((entry) => entry.userId),
});

/** Prisma's client and its transaction client, for the methods both can serve. */
type Db = PrismaClient | Prisma.TransactionClient;

class PrismaMessagingTx implements MessagingTx {
  constructor(private readonly db: Prisma.TransactionClient) {}

  async channel(channelId: string): Promise<ChannelRow | null> {
    const row = await this.db.channel.findUnique({
      where: { id: channelId },
      select: CHANNEL_SELECT,
    });
    return row ? toChannel(row) : null;
  }

  async channelByDmKey(dmKey: string): Promise<ChannelRow | null> {
    const row = await this.db.channel.findUnique({ where: { dmKey }, select: CHANNEL_SELECT });
    return row ? toChannel(row) : null;
  }

  async member(channelId: string, userId: string): Promise<MemberRow | null> {
    const row = await this.db.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: MEMBER_SELECT,
    });
    return row ? toMember(row) : null;
  }

  async members(channelId: string): Promise<MemberRow[]> {
    const rows = await this.db.channelMember.findMany({
      where: { channelId },
      select: MEMBER_SELECT,
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map(toMember);
  }

  /**
   * The one atomic primitive, and the reason the whole design works.
   *
   * A single `UPDATE ... RETURNING` takes a row lock on the channel, so two
   * concurrent senders queue instead of racing, and the allocation shares the
   * caller's transaction with the insert -- so a crash between them rolls the
   * number back rather than burning it and leaving a gap.
   *
   * **`RETURNING next_seq - 1`, not `RETURNING next_seq`.** Postgres returns the
   * post-update value, so on a fresh channel (`next_seq` defaults to 1) the bare
   * form hands out 2 and the first message in every channel is seq 2. The `- 1`
   * is what makes this agree with `test-repository.ts`, which returns the current
   * value and then increments, and with `seqSchema`, which requires >= 1. The SQL
   * quoted in docs/SPECS.md section 3.1 omits it; the behaviour here is the one
   * the tests pin, verified against Postgres directly (1, 2, 3 on three calls).
   */
  async allocateSeq(channelId: string): Promise<number> {
    const rows = await this.db.$queryRaw<{ seq: bigint }[]>`
      UPDATE channels SET next_seq = next_seq + 1
      WHERE id = ${channelId}
      RETURNING next_seq - 1 AS seq
    `;
    const row = rows[0];
    if (!row) throw new Error(`No channel ${channelId} to allocate a sequence number in.`);
    return narrowSeq(row.seq, 'channels.next_seq');
  }

  async insertMessage(message: NewMessage): Promise<MessageRow> {
    const row = await this.db.message.create({
      data: {
        channelId: message.channelId,
        seq: BigInt(message.seq),
        authorId: message.authorId,
        clientMessageId: message.clientMessageId,
        body: message.body,
        // `connect`, not `create`: the rows already exist, uploaded through the
        // API's upload route before the send. Creating them here would mean a
        // client could invent an attachment it never uploaded.
        attachments:
          message.attachmentIds.length > 0
            ? { connect: message.attachmentIds.map((id) => ({ id })) }
            : undefined,
        mentions:
          message.mentions.length > 0
            ? { createMany: { data: message.mentions.map((userId) => ({ userId })) } }
            : undefined,
      },
      select: MESSAGE_SELECT,
    });
    return toMessage(row);
  }

  async messageByClientId(
    channelId: string,
    clientMessageId: string,
  ): Promise<MessageRow | null> {
    const row = await this.db.message.findUnique({
      where: { channelId_clientMessageId: { channelId, clientMessageId } },
      select: MESSAGE_SELECT,
    });
    return row ? toMessage(row) : null;
  }

  async message(messageId: string): Promise<MessageRow | null> {
    const row = await this.db.message.findUnique({
      where: { id: messageId },
      select: MESSAGE_SELECT,
    });
    return row ? toMessage(row) : null;
  }

  async updateMessageBody(
    messageId: string,
    body: string,
    editedAt: Date,
  ): Promise<MessageRow> {
    const row = await this.db.message.update({
      where: { id: messageId },
      data: { body, editedAt },
      select: MESSAGE_SELECT,
    });
    return toMessage(row);
  }

  /**
   * The tombstone: the row and its seq survive, the body does not.
   *
   * A hard delete would leave a hole in the sequence, and a hole is
   * indistinguishable from a message a client has not received yet -- so every
   * reader of that channel would catch up forever. The `messages_body_not_blank`
   * CHECK is written to exempt exactly this case.
   *
   * Attachments are deleted rather than detached: leaving the rows would leave
   * files reachable by anybody who kept the id.
   */
  async softDeleteMessage(messageId: string, deletedAt: Date): Promise<MessageRow> {
    await this.db.attachment.deleteMany({ where: { messageId } });
    const row = await this.db.message.update({
      where: { id: messageId },
      data: { deletedAt, body: '' },
      select: MESSAGE_SELECT,
    });
    return toMessage(row);
  }

  /**
   * Monotonic, in one statement.
   *
   * `WHERE last_read_seq < $seq` is what makes a stale marker a no-op rather than
   * a regression. Two tabs on one channel routinely report different markers, and
   * the older one arriving second must not un-read what the newer one read. Doing
   * this as read-then-write would lose that race in exactly the common case.
   */
  async advanceReadMarker(channelId: string, userId: string, seq: number): Promise<number> {
    await this.db.$executeRaw`
      UPDATE channel_members SET last_read_seq = ${BigInt(seq)}
      WHERE channel_id = ${channelId} AND user_id = ${userId} AND last_read_seq < ${BigInt(seq)}
    `;
    const row = await this.db.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: { lastReadSeq: true },
    });
    if (!row) throw new Error(`No membership for ${userId} in ${channelId}.`);
    return narrowSeq(row.lastReadSeq, 'channel_members.last_read_seq');
  }

  async createChannel(input: NewChannel): Promise<ChannelRow> {
    const row = await this.db.channel.create({
      data: {
        kind: input.kind,
        slug: input.slug,
        name: input.name,
        topic: input.topic,
        dmKey: input.dmKey,
        createdById: input.createdById,
      },
      select: CHANNEL_SELECT,
    });
    return toChannel(row);
  }

  async addMember(channelId: string, userId: string, role: ChannelRole): Promise<MemberRow> {
    const row = await this.db.channelMember.create({
      data: { channelId, userId, role },
      select: MEMBER_SELECT,
    });
    return toMember(row);
  }
}

/**
 * How long a write transaction may take before Prisma rolls it back.
 *
 * The default is 5 seconds, which is generous for one send and not generous for
 * the integration lane's concurrency proof: N senders contending for one channel's
 * row lock serialise, so the last one waits for all the others. A timeout there
 * would present as `CONFLICT` and read as a bug in the retry logic rather than as
 * a test harness limit.
 */
const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

export class PrismaMessagingRepository implements MessagingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async withTransaction<T>(work: (tx: MessagingTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => work(new PrismaMessagingTx(tx)),
      TRANSACTION_OPTIONS,
    );
  }

  private get db(): Db {
    return this.prisma;
  }

  async channel(channelId: string): Promise<ChannelRow | null> {
    const row = await this.db.channel.findUnique({
      where: { id: channelId },
      select: CHANNEL_SELECT,
    });
    return row ? toChannel(row) : null;
  }

  async channelBySlug(slug: string): Promise<ChannelRow | null> {
    const row = await this.db.channel.findUnique({ where: { slug }, select: CHANNEL_SELECT });
    return row ? toChannel(row) : null;
  }

  async member(channelId: string, userId: string): Promise<MemberRow | null> {
    const row = await this.db.channelMember.findUnique({
      where: { channelId_userId: { channelId, userId } },
      select: MEMBER_SELECT,
    });
    return row ? toMember(row) : null;
  }

  async members(channelId: string): Promise<MemberRow[]> {
    const rows = await this.db.channelMember.findMany({
      where: { channelId },
      select: MEMBER_SELECT,
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map(toMember);
  }

  /**
   * A page of history, read backwards, keyset on `seq`.
   *
   * `beforeSeq` is exclusive, so paging is "everything below the oldest line I
   * already have", which stays correct when a message arrives while the reader is
   * scrolled up. OFFSET would shift the window by one on every new message and the
   * reader would see a line twice or not at all.
   *
   * **Returns up to `limit + 1` rows.** The caller asks for a page size and gets
   * one extra row when there is more behind it, which is how `hasMore` becomes a
   * fact rather than a second `COUNT` over the same index; the caller drops the
   * extra before rendering. (`ports.ts` describes the extra row as dropped by the
   * adapter, which cannot be right -- dropping it here would destroy the only
   * evidence `hasMore` is derived from.)
   */
  async history(query: HistoryQuery): Promise<MessageRow[]> {
    const rows = await this.db.message.findMany({
      where: {
        channelId: query.channelId,
        ...(query.beforeSeq === undefined ? {} : { seq: { lt: BigInt(query.beforeSeq) } }),
      },
      select: MESSAGE_SELECT,
      orderBy: { seq: 'desc' },
      take: query.limit + 1,
    });
    return rows.map(toMessage);
  }

  /**
   * Catch-up: everything after `afterSeq`, ascending, bounded.
   *
   * Ascending because the client splices it onto the end of what it already has,
   * and the reorder buffer in `services/sequencing` delivers contiguously. Also
   * `limit + 1`, for the same reason as `history`: the extra row is what tells the
   * caller the gap was wider than `CATCHUP_MAX_MESSAGES` and the answer must be
   * `complete: false`.
   */
  async forward(query: ForwardQuery): Promise<MessageRow[]> {
    const rows = await this.db.message.findMany({
      where: { channelId: query.channelId, seq: { gt: BigInt(query.afterSeq) } },
      select: MESSAGE_SELECT,
      orderBy: { seq: 'asc' },
      take: query.limit + 1,
    });
    return rows.map(toMessage);
  }

  async channelsFor(userId: string): Promise<{ channel: ChannelRow; member: MemberRow }[]> {
    const rows = await this.db.channelMember.findMany({
      where: { userId },
      select: { ...MEMBER_SELECT, channel: { select: CHANNEL_SELECT } },
    });
    return rows.map((row) => ({ channel: toChannel(row.channel), member: toMember(row) }));
  }

  async counterparts(channelId: string, userId: string): Promise<MemberRow[]> {
    const rows = await this.db.channelMember.findMany({
      where: { channelId, userId: { not: userId } },
      select: MEMBER_SELECT,
      orderBy: { joinedAt: 'asc' },
    });
    return rows.map(toMember);
  }

  /**
   * How many of the reader's unread messages mention them by name.
   *
   * Deleted messages are excluded: a mention in a message that has been retracted
   * is not something to badge somebody about, and the partial index
   * `messages_channel_seq_live` is built `WHERE deleted_at IS NULL` for exactly
   * this shape of query.
   */
  async unreadMentions(channelId: string, userId: string, afterSeq: number): Promise<number> {
    return this.db.mention.count({
      where: {
        userId,
        message: {
          channelId,
          seq: { gt: BigInt(afterSeq) },
          deletedAt: null,
          // A person mentioning themselves should not badge themselves.
          authorId: { not: userId },
        },
      },
    });
  }
}
