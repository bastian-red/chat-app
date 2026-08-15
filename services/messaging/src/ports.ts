/**
 * The repository port.
 *
 * `services/messaging` is where the write path lives, and it is imported by two
 * processes: `apps/api` (a REST mutation) and `apps/realtime` (a socket event).
 * One `sendMessage`, one permission check, one hop per message -- rather than the
 * gateway forwarding to the API, which would double the latency of the one
 * interaction the product is judged on.
 *
 * It talks to Postgres through this interface rather than through Prisma
 * directly, for one reason that pays for itself immediately: the permission
 * matrix, the idempotency branch, the read-marker monotonicity and the DM-key
 * derivation are the interesting part, and they can be tested exhaustively
 * against an in-memory repository in the gate lane -- in milliseconds, with no
 * container. What that lane *cannot* prove is that Postgres serialises two
 * concurrent sequence allocations, so the integration lane runs the same
 * functions against the real thing. Two lanes, one implementation, no mocks of
 * the database's own guarantees.
 *
 * The port is deliberately thin and boring. It exposes rows and one atomic
 * primitive (`allocateSeq`), not behaviour: there is no
 * `sendMessageAndBumpUnread`, because then the logic under test would live in the
 * adapter and the fake would be a second implementation of it.
 */
import type { ChannelKind, ChannelRole } from '@chat/shared';

export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  slug: string | null;
  name: string | null;
  topic: string | null;
  /** The next seq this channel will hand out. `nextSeq - 1` is the highest in use. */
  nextSeq: number;
  dmKey: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MemberRow {
  channelId: string;
  userId: string;
  name: string;
  email: string;
  role: ChannelRole;
  lastReadSeq: number;
  joinedAt: Date;
}

/**
 * An attachment as it appears on a message.
 *
 * No `messageId`. The column exists and is nullable -- an upload lives before the
 * send that names it -- but a row reached through `MessageRow.attachments` is by
 * construction attached to that message, so carrying the id here would be a field
 * that is either redundant or, for the orphan case, `null` on a type where every
 * reader would assume it could not be.
 */
export interface AttachmentRow {
  id: string;
  filename: string;
  contentType: string;
  byteSize: number;
  storageKey: string;
}

export interface MessageRow {
  id: string;
  channelId: string;
  seq: number;
  authorId: string | null;
  authorName: string | null;
  clientMessageId: string;
  body: string;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  attachments: AttachmentRow[];
  mentions: string[];
}

export interface NewMessage {
  channelId: string;
  seq: number;
  authorId: string;
  clientMessageId: string;
  body: string;
  attachmentIds: string[];
  mentions: string[];
}

/**
 * A page of history, read backwards from `beforeSeq`.
 *
 * `limit + 1` rows are fetched by the adapter so `hasMore` is a fact rather than
 * a guess; the extra row is dropped before it is returned. Asking for a count
 * instead would be a second query over the same index on every page.
 */
export interface HistoryQuery {
  channelId: string;
  beforeSeq?: number;
  limit: number;
}

export interface ForwardQuery {
  channelId: string;
  afterSeq: number;
  limit: number;
}

/**
 * The transaction handle.
 *
 * Everything the write path does inside one unit of work goes through this, and
 * the reason it exists rather than the functions calling the repository directly
 * is `allocateSeq`: the allocation and the insert **must** be in one transaction,
 * or a crash between them burns a sequence number and leaves a permanent hole
 * that every client's gap detector will chase forever.
 */
export interface MessagingTx {
  channel(channelId: string): Promise<ChannelRow | null>;
  channelByDmKey(dmKey: string): Promise<ChannelRow | null>;
  member(channelId: string, userId: string): Promise<MemberRow | null>;
  members(channelId: string): Promise<MemberRow[]>;

  /**
   * Take the next sequence number for this channel.
   *
   * **The one operation that must be atomic**, and the reason this port has a
   * transaction at all. The adapter implements it as
   *
   *     UPDATE channels SET next_seq = next_seq + 1 WHERE id = $1 RETURNING next_seq
   *
   * which takes a row lock for the duration of the transaction, so two concurrent
   * senders serialise instead of racing. `SELECT` then `UPDATE` is the obvious
   * alternative and is wrong: between the two statements another transaction
   * reads the same value, and both messages are written with the same seq --
   * caught by the unique index, but only after both have done their work.
   *
   * Returns the seq the caller now owns. The value returned is the **new**
   * `next_seq`, minus nothing: `next_seq` starts at 1, so the first caller gets
   * 1 and the column is left at 2.
   */
  allocateSeq(channelId: string): Promise<number>;

  insertMessage(message: NewMessage): Promise<MessageRow>;
  messageByClientId(channelId: string, clientMessageId: string): Promise<MessageRow | null>;
  message(messageId: string): Promise<MessageRow | null>;
  updateMessageBody(messageId: string, body: string, editedAt: Date): Promise<MessageRow>;
  softDeleteMessage(messageId: string, deletedAt: Date): Promise<MessageRow>;

  /**
   * Move a member's read marker forward.
   *
   * Monotonic in the adapter's SQL (`WHERE last_read_seq < $2`), not in the
   * caller: two tabs on one channel routinely report different markers, and the
   * older one arriving second must not un-read what the newer one read. Returns
   * what the marker is **after** the write, which is the value the ack carries --
   * so a client whose update lost the race learns the real number rather than the
   * one it asked for.
   */
  advanceReadMarker(channelId: string, userId: string, seq: number): Promise<number>;

  createChannel(input: NewChannel): Promise<ChannelRow>;
  addMember(channelId: string, userId: string, role: ChannelRole): Promise<MemberRow>;
}

export interface NewChannel {
  kind: ChannelKind;
  slug: string | null;
  name: string | null;
  topic: string | null;
  dmKey: string | null;
  createdById: string;
}

export interface MessagingRepository {
  /**
   * Run `work` inside one database transaction.
   *
   * The callback shape rather than begin/commit methods, because a caller cannot
   * then forget to commit and cannot hold a transaction open across an await it
   * did not mean to.
   */
  withTransaction<T>(work: (tx: MessagingTx) => Promise<T>): Promise<T>;

  /** Reads that need no transaction. Kept off `MessagingTx` so the hot read path
   * does not open one for a single SELECT. */
  channel(channelId: string): Promise<ChannelRow | null>;
  channelBySlug(slug: string): Promise<ChannelRow | null>;
  member(channelId: string, userId: string): Promise<MemberRow | null>;
  members(channelId: string): Promise<MemberRow[]>;
  history(query: HistoryQuery): Promise<MessageRow[]>;
  forward(query: ForwardQuery): Promise<MessageRow[]>;
  channelsFor(userId: string): Promise<{ channel: ChannelRow; member: MemberRow }[]>;
  /** Everyone in a DM channel other than `userId`, for its label. */
  counterparts(channelId: string, userId: string): Promise<MemberRow[]>;
  /** How many of a member's unread messages mention them. */
  unreadMentions(channelId: string, userId: string, afterSeq: number): Promise<number>;
}

/**
 * Why a write was refused.
 *
 * The same closed set as `errorCodeSchema` in the contract, deliberately: this
 * service is called from two transports and each maps the code to its own
 * vocabulary (an HTTP status, a socket ack). A service that threw prose would
 * force both of them to match on it.
 */
export type MessagingFailure =
  'FORBIDDEN' | 'NOT_FOUND' | 'INVALID' | 'CONFLICT' | 'TOO_FAR_BEHIND';

export class MessagingError extends Error {
  constructor(
    readonly code: MessagingFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}
