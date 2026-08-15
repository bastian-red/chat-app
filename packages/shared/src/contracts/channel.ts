/**
 * What a channel and a message look like on the wire.
 *
 * One definition, imported by the API, the gateway, the web app and every test.
 * The alternative -- a DTO in Nest, an interface in the client, a fixture in the
 * specs -- is three shapes that agree until one of them changes.
 *
 * The rule that shapes this file: **the server sends results, never intents.**
 * A client asks to send a message body; what comes back, to the sender and to
 * everybody else, is a `Message` with the `seq` the server allocated. The client
 * renders its own message optimistically with no seq at all and replaces it when
 * the real one arrives. Nothing downstream ever has to reason about a message
 * whose position in the conversation is a guess.
 */
import { z } from 'zod';

import {
  channelKindSchema,
  channelNameSchema,
  channelRoleSchema,
  channelSlugSchema,
  channelTopicSchema,
  clientMessageIdSchema,
  idSchema,
  messageBodySchema,
  presenceStateSchema,
  readMarkerSchema,
  seqSchema,
} from './primitives';

/**
 * An ISO-8601 instant, kept as a string.
 *
 * Not `z.coerce.date()`. A `Date` does not survive `JSON.stringify` as a `Date`,
 * so a schema that produced one would type the client as holding something the
 * socket cannot deliver. The string is parsed where it is rendered, against the
 * reader's own zone.
 */
export const instantSchema = z.string().datetime();

export const attachmentSchema = z.object({
  id: idSchema,
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(128),
  byteSize: z.number().int().positive(),
  /** Where the browser fetches it. Behind the session, never a static path. */
  url: z.string().min(1),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/**
 * The author of a message, denormalised onto it.
 *
 * A message carries its author's name and initials rather than an id the client
 * has to resolve. In a channel with a hundred participants and forty messages on
 * screen, the alternative is either a join per message or a client-side user
 * cache that goes stale exactly when somebody changes their name.
 *
 * Nullable, because `authorId` is `SetNull` on user delete: the conversation is a
 * record and outlives the account. The client renders "Deleted account", which is
 * a fact, rather than a blank space, which is a rendering bug.
 */
export const authorSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    initials: z.string(),
  })
  .nullable();

export type Author = z.infer<typeof authorSchema>;

export const messageSchema = z.object({
  id: idSchema,
  channelId: idSchema,
  /** Unique and gapless within the channel. The only ordering anything uses. */
  seq: seqSchema,
  author: authorSchema,
  clientMessageId: clientMessageIdSchema,
  /** Empty exactly when `deletedAt` is set. */
  body: z.string(),
  createdAt: instantSchema,
  editedAt: instantSchema.nullable(),
  deletedAt: instantSchema.nullable(),
  attachments: z.array(attachmentSchema),
  /** User ids this message mentions. The client highlights its own. */
  mentions: z.array(idSchema),
});

export type Message = z.infer<typeof messageSchema>;

export const memberSchema = z.object({
  userId: idSchema,
  name: z.string(),
  email: z.string().email(),
  initials: z.string(),
  role: channelRoleSchema,
  /** From the presence roster, not from the database. `offline` if absent. */
  presence: presenceStateSchema,
});

export type Member = z.infer<typeof memberSchema>;

/**
 * A channel as the sidebar sees it: enough to render a row, and nothing else.
 *
 * `unread` is computed (`nextSeq - lastReadSeq - 1`), never stored. Storing it
 * would mean two writers for one fact -- the send path and the read path -- and
 * every counter bug in every chat application is that pair disagreeing.
 */
export const channelSummarySchema = z.object({
  id: idSchema,
  kind: channelKindSchema,
  /** Null for a DM: its name is whoever else is in it, resolved per reader. */
  slug: channelSlugSchema.nullable(),
  name: channelNameSchema.nullable(),
  topic: channelTopicSchema.nullable(),
  role: channelRoleSchema,
  unread: z.number().int().nonnegative(),
  /** How many of those unread mention the reader by name. */
  unreadMentions: z.number().int().nonnegative(),
  /** The highest seq in the channel; zero when nothing has been said. */
  lastSeq: z.number().int().nonnegative(),
  lastMessageAt: instantSchema.nullable(),
  /**
   * The other participants, for a DM's label and avatar. Empty for a named
   * channel, where the name is the name.
   */
  counterparts: z.array(
    z.object({ userId: idSchema, name: z.string(), initials: z.string() }),
  ),
});

export type ChannelSummary = z.infer<typeof channelSummarySchema>;

/**
 * A channel opened for reading: its header, its members, and one page of
 * history.
 *
 * The page is the **newest** one, because that is where a conversation is read
 * from. `hasMore` says whether scrolling up will find anything, and the client
 * pages backwards with `beforeSeq`.
 */
export const channelViewSchema = z.object({
  id: idSchema,
  kind: channelKindSchema,
  slug: channelSlugSchema.nullable(),
  name: channelNameSchema.nullable(),
  topic: channelTopicSchema.nullable(),
  role: channelRoleSchema,
  members: z.array(memberSchema),
  counterparts: z.array(
    z.object({ userId: idSchema, name: z.string(), initials: z.string() }),
  ),
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
  /** The reader's own marker, so the client can draw the unread divider. */
  lastReadSeq: readMarkerSchema,
  /** `nextSeq - 1`: the highest seq that exists. Zero for an empty channel. */
  lastSeq: z.number().int().nonnegative(),
});

export type ChannelView = z.infer<typeof channelViewSchema>;

/**
 * A page of history, read backwards.
 *
 * Keyset, never OFFSET. `beforeSeq` is exclusive, so paging is "everything below
 * the oldest line I already have" -- which stays correct when a message arrives
 * while the reader is scrolled up. With OFFSET, every new message shifts the
 * window by one and the reader sees a line twice or not at all.
 */
export const historyPageSchema = z.object({
  messages: z.array(messageSchema),
  hasMore: z.boolean(),
});

export type HistoryPage = z.infer<typeof historyPageSchema>;

/**
 * The answer to "what did I miss?".
 *
 * `complete: false` means the gap was larger than `CATCHUP_MAX_MESSAGES` and the
 * client must reload the channel instead of splicing. Streaming a week of backlog
 * through a socket to a client that will render forty lines of it is how a
 * reconnect storm takes a gateway down.
 */
export const catchUpSchema = z.object({
  messages: z.array(messageSchema),
  complete: z.boolean(),
  /** The highest seq that exists now, so the client knows where it stands. */
  lastSeq: z.number().int().nonnegative(),
});

export type CatchUp = z.infer<typeof catchUpSchema>;

// --- Requests ---------------------------------------------------------------

export const sendMessageSchema = z.object({
  channelId: idSchema,
  /**
   * Generated by the client before the first attempt and reused by every retry.
   * This is the whole idempotency mechanism; see the note on `Message` in
   * schema.prisma.
   */
  clientMessageId: clientMessageIdSchema,
  body: messageBodySchema,
  /** Ids of attachments already uploaded through the API's upload route. */
  attachmentIds: z.array(idSchema).max(10).optional(),
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  channelId: idSchema,
  messageId: idSchema,
  body: messageBodySchema,
});

export const deleteMessageSchema = z.object({
  channelId: idSchema,
  messageId: idSchema,
});

/**
 * "I have read up to here."
 *
 * Monotonic on the server: a marker lower than the stored one is ignored rather
 * than rejected. Two tabs on one channel routinely report different markers, and
 * the older one arriving second must not un-read what the newer one read.
 */
export const markReadSchema = z.object({
  channelId: idSchema,
  seq: readMarkerSchema,
});

export const createChannelSchema = z.object({
  name: channelNameSchema,
  slug: channelSlugSchema,
  topic: channelTopicSchema.optional(),
  kind: z.enum(['PUBLIC', 'PRIVATE']),
});

export const openDmSchema = z.object({ userId: idSchema });

export const historyQuerySchema = z.object({
  channelId: idSchema,
  /** Exclusive. Absent means "the newest page". */
  beforeSeq: seqSchema.optional(),
});

export const catchUpQuerySchema = z.object({
  channelId: idSchema,
  /** Exclusive. The highest seq the client is sure it has. */
  afterSeq: readMarkerSchema,
});
