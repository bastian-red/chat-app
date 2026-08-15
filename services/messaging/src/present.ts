/**
 * Rows to wire payloads, in one place.
 *
 * `MessageRow` is what the database hands back: `Date` objects, an
 * `attachments[].storageKey`, and the author flattened into `authorId` /
 * `authorName`. `Message` is what the contract in `@chat/shared` says goes over
 * the socket: ISO-8601 strings, an `attachments[].url`, and a nested `author`.
 * Something has to convert, and **two processes need the conversion**:
 * `apps/api` when it answers a REST read, and `apps/realtime` when it broadcasts.
 *
 * `packages/shared/src/broadcast.ts` cannot do it. It deliberately takes domain
 * objects and builds the envelope, but the objects it takes are already the
 * contract types -- `ChannelBroadcast.messageNew(channelId, message: Message, ...)`
 * -- so the row is gone by the time it is called. (The header of `messages.ts`
 * says broadcast.ts "owns the mapping from a row to a wire payload"; it owns the
 * mapping from a *domain object* to one. This module is the missing half.)
 *
 * The failure this prevents is the quiet one. Two hand-written mappings agree on
 * the day they are written. Then one of them starts sending `createdAt` as a
 * `Date`, `JSON.stringify` renders it as a string the client's `messageSchema`
 * happens to accept, and nothing breaks until someone adds a field to one copy.
 * The write succeeds, the emit succeeds, and the other person's conversation
 * simply stops updating -- which from the outside is a dropped socket.
 *
 * Two invariants are **enforced here rather than trusted**, because this module
 * is the last thing every payload passes through:
 *
 * - A tombstone carries no body and no attachments. `deletedAt` being set and a
 *   body still being present is a contract violation (`Message.body` is "empty
 *   exactly when `deletedAt` is set"), and the cost of it leaking once is that a
 *   deleted message is readable by everybody in the channel.
 * - Instants are always `Date.prototype.toISOString()`. `instantSchema` is
 *   `z.string().datetime()`, which accepts `2026-08-11T09:00:00.000Z` and
 *   **rejects** `2026-08-11T09:00:00+00:00`. Any formatter that emits an offset
 *   instead of `Z` produces a payload the client refuses to parse, and the symptom
 *   is a conversation that renders empty rather than an error anybody can read.
 */
import {
  initialsOf,
  type Author,
  type ChannelSummary,
  type Member,
  type Message,
} from '@chat/shared';
import type { Attachment, PresenceState } from '@chat/shared';

import { unreadCount } from './messages';
import type { AttachmentRow, ChannelRow, MemberRow, MessageRow } from './ports';

/**
 * How an attachment is addressed by the browser.
 *
 * Injected rather than built here, because this package must not know it. The
 * storage key is a server-side path under `UPLOAD_DIR`; the URL is a route on
 * `apps/api` that checks the session before it streams the bytes. Hardcoding one
 * would either leak the disk layout into the wire format or make this module
 * depend on the API's routing table.
 */
export interface PresentMessageOptions {
  attachmentUrl: (attachment: AttachmentRow) => string;
}

/** The shape a DM's label is built from, for both the summary and the view. */
export interface Counterpart {
  userId: string;
  name: string;
  initials: string;
}

/**
 * Facts about a channel that no single row carries.
 *
 * `unreadMentions` needs a `COUNT` over the mentions table and `lastMessageAt`
 * needs the newest message, so both are the caller's to fetch. They are grouped
 * into one argument rather than appended as positional parameters because two
 * adjacent numbers in a call site are two numbers nobody can tell apart.
 */
export interface ChannelSummaryExtras {
  unreadMentions: number;
  lastMessageAt: Date | null;
  counterparts: readonly MemberRow[];
}

const instant = (value: Date): string => value.toISOString();

export function presentAttachment(row: AttachmentRow, options: PresentMessageOptions): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.contentType,
    byteSize: row.byteSize,
    url: options.attachmentUrl(row),
  };
}

/**
 * The author, or nobody.
 *
 * `null` means the account is gone: `Message.authorId` is `SetNull` on user
 * delete, because a conversation is a record and outlives the account. The
 * wording for that state ("Deleted account") belongs to whoever renders it, not
 * here -- a service returns facts, and the client knows whether it is drawing a
 * message header or a notification.
 *
 * A non-null `authorId` with a null `authorName` is unreachable through the
 * adapter (the name comes from a join on a row the foreign key guarantees), and
 * it collapses to the same answer rather than throwing. Throwing on this path
 * would fail a broadcast for a write that has already committed, which loses the
 * message for everybody else to report an inconsistency to nobody.
 */
function presentAuthor(row: MessageRow): Author {
  if (row.authorId === null || row.authorName === null) return null;
  return { id: row.authorId, name: row.authorName, initials: initialsOf(row.authorName) };
}

export function presentMessage(row: MessageRow, options: PresentMessageOptions): Message {
  const deleted = row.deletedAt !== null;
  return {
    id: row.id,
    channelId: row.channelId,
    seq: row.seq,
    author: presentAuthor(row),
    clientMessageId: row.clientMessageId,
    // Not `row.body`. See the header: the tombstone rule is enforced, not trusted.
    body: deleted ? '' : row.body,
    createdAt: instant(row.createdAt),
    editedAt: row.editedAt === null ? null : instant(row.editedAt),
    deletedAt: row.deletedAt === null ? null : instant(row.deletedAt),
    attachments: deleted ? [] : row.attachments.map((entry) => presentAttachment(entry, options)),
    mentions: [...row.mentions],
  };
}

/**
 * A member, with presence merged in.
 *
 * `presence` is a parameter and not a field on `MemberRow` because it does not
 * come from Postgres at all -- it is read from the Redis roster in
 * `services/presence`, and it is worthless a minute after it is written. Making
 * the caller pass it is what stops somebody adding a `presence` column.
 *
 * `offline` is the honest default for "not in the roster", and it is the caller's
 * job to say so; there is no default here, because a silent `offline` would hide
 * a roster that was never queried.
 */
export function presentMember(row: MemberRow, presence: PresenceState): Member {
  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    initials: initialsOf(row.name),
    role: row.role,
    presence,
  };
}

export function presentCounterpart(row: MemberRow): Counterpart {
  return { userId: row.userId, name: row.name, initials: initialsOf(row.name) };
}

/**
 * One row of the sidebar.
 *
 * `unread` comes from `unreadCount`, the same function the read path uses, rather
 * than being recomputed here. Two expressions for `nextSeq - 1 - lastReadSeq`
 * that differ by one is exactly how every unread badge in every chat application
 * ends up permanently wrong for the people who never opened the channel.
 */
export function presentChannelSummary(
  channel: ChannelRow,
  member: MemberRow,
  extras: ChannelSummaryExtras,
): ChannelSummary {
  return {
    id: channel.id,
    kind: channel.kind,
    slug: channel.slug,
    name: channel.name,
    topic: channel.topic,
    role: member.role,
    unread: unreadCount(channel.nextSeq, member.lastReadSeq),
    unreadMentions: extras.unreadMentions,
    // `nextSeq` is the number the channel will hand out *next*, so the highest
    // that exists is one below it, and an empty channel reports 0 rather than -1.
    lastSeq: Math.max(0, channel.nextSeq - 1),
    lastMessageAt: extras.lastMessageAt === null ? null : instant(extras.lastMessageAt),
    counterparts: extras.counterparts.map(presentCounterpart),
  };
}
