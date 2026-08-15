/**
 * The socket protocol.
 *
 * One schema per event, imported by the client, the gateway and the tests. There
 * are no hand-written duplicates anywhere: `eslint.config.mjs` fails a string
 * literal matching an event name inside `e2e/**`, precisely so a spec cannot
 * quietly wait for `'message.send'` after the gateway started emitting
 * `'message.new'`. That spec would hang until the timeout and report "the message
 * never arrived", which is a sentence about the product and a lie about the
 * cause.
 *
 * Three shapes hold across the whole protocol:
 *
 * 1. **Every client event is acknowledged.** Socket.io acks are the transport's
 *    own request/response, and a fire-and-forget send has nowhere to report
 *    `RATE_LIMITED` or `FORBIDDEN`. The send path needs the ack for a second
 *    reason the sibling project did not: the ack carries the allocated `seq`, and
 *    a client that never learns it cannot tell its own optimistic line apart from
 *    the broadcast of the same message.
 * 2. **The server never echoes an intent, only a result.** The client asks to
 *    send a body; the broadcast carries the stored message with the server's seq.
 *    Where the two disagree the server wins, which is what makes convergence a
 *    property rather than a hope.
 * 3. **Failures are typed codes, not messages.** `TOO_FAR_BEHIND` drives a
 *    reload, `FORBIDDEN` an explanation, `RATE_LIMITED` a backoff. A client that
 *    has to match on prose to tell them apart breaks the first time the prose
 *    improves.
 */
import { z } from 'zod';

import {
  catchUpQuerySchema,
  catchUpSchema,
  channelViewSchema,
  deleteMessageSchema,
  editMessageSchema,
  markReadSchema,
  memberSchema,
  messageSchema,
  sendMessageSchema,
} from './channel';
import {
  activitySchema,
  idSchema,
  presenceStateSchema,
  readMarkerSchema,
  seqSchema,
} from './primitives';

/**
 * Event names, as constants.
 *
 * `as const` and exported, so `socket.on(SERVER_EVENTS.messageNew, ...)` is a
 * typo-proof reference and a rename is a compiler error rather than a silent
 * no-op. A socket listener for an event nobody emits is the quietest bug in this
 * whole codebase: nothing throws, nothing logs, the conversation just stops
 * arriving.
 */
export const CLIENT_EVENTS = {
  channelJoin: 'channel.join',
  channelLeave: 'channel.leave',
  messageSend: 'message.send',
  messageEdit: 'message.edit',
  messageDelete: 'message.delete',
  messageRead: 'message.read',
  /** "I missed some. Here is the last seq I am sure of." */
  channelCatchUp: 'channel.catchup',
  typingStart: 'typing.start',
  typingStop: 'typing.stop',
  presencePing: 'presence.ping',
} as const;

export const SERVER_EVENTS = {
  channelState: 'channel.state',
  messageNew: 'message.new',
  messageUpdated: 'message.updated',
  messageDeleted: 'message.deleted',
  /**
   * Somebody else's read marker moved. Only the reader's own marker changes what
   * they see, but a DM shows "seen" and that needs the other side's.
   */
  readChanged: 'read.changed',
  typingChanged: 'typing.changed',
  presenceChanged: 'presence.changed',
  memberChanged: 'member.changed',
  /**
   * The channel's own header changed -- renamed, topic edited. A REST call, not a
   * socket one, because it happens from a settings form where no socket for that
   * channel need be open. It still has to reach everybody who does have it open,
   * which makes this one of the two events `apps/api` emits through the Redis
   * emitter rather than through a Socket.io server it does not run.
   */
  channelUpdated: 'channel.updated',
  // `server.error`, not the bare `error`. Two reasons, both concrete:
  //
  //   - Socket.io gives `error` its own meaning on the manager and around the
  //     connection lifecycle, so a custom event by that name is a name shared
  //     with the library. It works until it does not, and when it does not the
  //     symptom is an error handler that fires for something that was never an
  //     application error.
  //   - Every other event here is `subject.verb`. The gateway's per-socket rate
  //     limiter and the eslint rule that keeps literals out of e2e/ both key off
  //     that shape, and one exception is an exception each of them has to carry.
  error: 'server.error',
} as const;

export type ClientEvent = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];
export type ServerEvent = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];

// --- Failures ---------------------------------------------------------------

/**
 * Why a request was refused, as a closed set the client can branch on.
 *
 * - `FORBIDDEN`      you are not in this channel, or your role does not allow
 *                    this. Do not retry; tell the person.
 * - `NOT_FOUND`      the channel or message is gone. Resync.
 * - `INVALID`        the payload failed its schema. A bug in the client.
 * - `CONFLICT`       the sequence could not be allocated within
 *                    SEND_RETRY_ATTEMPTS. Genuinely rare; a retry is reasonable
 *                    and is safe, because the client id makes it idempotent.
 * - `TOO_FAR_BEHIND` the catch-up gap exceeded CATCHUP_MAX_MESSAGES. Reload the
 *                    channel rather than splicing. Its own code because it is the
 *                    one failure whose correct handling is *not* a retry.
 * - `RATE_LIMITED`   too many events on this socket. Back off.
 * - `INTERNAL`       everything else. The only code allowed to be vague, and the
 *                    only one whose message is not shown to the user.
 */
export const errorCodeSchema = z.enum([
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID',
  'CONFLICT',
  'TOO_FAR_BEHIND',
  'RATE_LIMITED',
  'INTERNAL',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const socketErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  /** Which event failed, so a client with several in flight can tell them apart. */
  event: z.string().optional(),
});

/**
 * The ack envelope.
 *
 * A discriminated union on `ok` rather than "data is present or an error is": the
 * union makes the failure branch impossible to forget, because TypeScript will
 * not let the success field be read until `ok` has been checked.
 */
export function ackSchema<T extends z.ZodTypeAny>(data: T) {
  return z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data }),
    z.object({ ok: z.literal(false), error: socketErrorSchema }),
  ]);
}

/** The ack for an event whose success carries nothing but the fact of it. */
export const emptyAckSchema = ackSchema(z.object({}).strict());

export type Ack<T> =
  { ok: true; data: T } | { ok: false; error: z.infer<typeof socketErrorSchema> };

// --- Handshake --------------------------------------------------------------

/**
 * What the client puts in `io(url, { auth })`.
 *
 * The token is the same HS256 service token the REST client carries, minted by
 * the web app for the signed-in session (`apps/web/lib/service-token.ts`). One
 * secret, three verifiers: the web app mints, the API and the gateway check. That
 * is why AUTH_SECRET is not optional in `scripts/dev.sh` -- a missing one does not
 * merely break sign-in, it makes every socket handshake fail, which presents as a
 * conversation that renders and never moves.
 */
export const handshakeAuthSchema = z.object({
  token: z.string().min(1),
});

// --- Client -> server payloads ---------------------------------------------

export const channelJoinSchema = z.object({ channelId: idSchema });
export const channelLeaveSchema = z.object({ channelId: idSchema });

export const messageSendPayloadSchema = sendMessageSchema;
export const messageEditPayloadSchema = editMessageSchema;
export const messageDeletePayloadSchema = deleteMessageSchema;
export const messageReadPayloadSchema = markReadSchema;
export const channelCatchUpPayloadSchema = catchUpQuerySchema;

export const typingPayloadSchema = z.object({ channelId: idSchema });

export const presencePingPayloadSchema = z.object({
  channelId: idSchema,
  activity: activitySchema,
});

// --- Server -> client payloads ---------------------------------------------

/**
 * The whole channel, sent on join and on resync.
 *
 * It carries a page of history rather than every message, for the same reason the
 * REST view does: a channel with 200,000 messages must not be a 200,000-row
 * broadcast to somebody who clicked on it.
 */
export const channelStateSchema = channelViewSchema;

export const messageNewSchema = z.object({ message: messageSchema });

export const messageUpdatedSchema = z.object({ message: messageSchema });

/**
 * A deletion, as the message it left behind.
 *
 * The whole message, not just its id: the row still exists, still holds its seq,
 * and now has an empty body and a `deletedAt`. Sending only the id would make the
 * client invent the tombstone, and a client that invents state is a client that
 * can invent it differently from the server.
 */
export const messageDeletedSchema = z.object({ message: messageSchema });

export const readChangedSchema = z.object({
  channelId: idSchema,
  userId: idSchema,
  seq: readMarkerSchema,
});

/**
 * Who is typing, as the whole set rather than as a delta.
 *
 * A join/leave delta would require every client to hold a set that can drift out
 * of sync and never repair itself -- a missed "stopped" leaves somebody typing
 * forever. The set is small by construction (it is bounded by the channel's
 * membership and by a 5-second TTL), so sending all of it makes every broadcast a
 * complete correction.
 */
export const typingChangedSchema = z.object({
  channelId: idSchema,
  typing: z.array(z.object({ userId: idSchema, name: z.string() })),
});

export const presenceChangedSchema = z.object({
  channelId: idSchema,
  members: z.array(
    z.object({
      userId: idSchema,
      name: z.string(),
      initials: z.string(),
      state: presenceStateSchema,
    }),
  ),
});

export const memberChangedSchema = z.object({
  channelId: idSchema,
  members: z.array(memberSchema),
});

export const channelUpdatedSchema = z.object({
  channelId: idSchema,
  name: z.string().nullable(),
  topic: z.string().nullable(),
});

// --- Acks -------------------------------------------------------------------

/**
 * What a successful send returns.
 *
 * The whole stored message, and `duplicate` beside it. The flag is not
 * decoration: a client that retried after a lost ack gets `duplicate: true` with
 * the original message, which tells it to reconcile rather than to render a
 * second line. Without it, "the send succeeded" and "the send had already
 * succeeded" are the same answer and the client cannot tell whether its earlier
 * optimistic line is this one.
 */
export const messageSendAckSchema = z.object({
  message: messageSchema,
  duplicate: z.boolean(),
});

export const catchUpAckSchema = catchUpSchema;

export const readAckSchema = z.object({
  /** What the server stored. Lower than requested when a newer marker won. */
  seq: readMarkerSchema,
});

export const joinAckSchema = z.object({
  /** The highest seq that exists, so the client knows what it is catching up to. */
  lastSeq: z.number().int().nonnegative(),
});

// --- Types ------------------------------------------------------------------

export type ChannelJoinPayload = z.infer<typeof channelJoinSchema>;
export type MessageSendPayload = z.infer<typeof messageSendPayloadSchema>;
export type MessageEditPayload = z.infer<typeof messageEditPayloadSchema>;
export type MessageDeletePayload = z.infer<typeof messageDeletePayloadSchema>;
export type MessageReadPayload = z.infer<typeof messageReadPayloadSchema>;
export type ChannelCatchUpPayload = z.infer<typeof channelCatchUpPayloadSchema>;
export type PresencePingPayload = z.infer<typeof presencePingPayloadSchema>;
export type TypingPayload = z.infer<typeof typingPayloadSchema>;

export type ChannelState = z.infer<typeof channelStateSchema>;
export type MessageNew = z.infer<typeof messageNewSchema>;
export type MessageUpdated = z.infer<typeof messageUpdatedSchema>;
export type MessageDeleted = z.infer<typeof messageDeletedSchema>;
export type ReadChanged = z.infer<typeof readChangedSchema>;
export type TypingChanged = z.infer<typeof typingChangedSchema>;
export type PresenceChanged = z.infer<typeof presenceChangedSchema>;
export type MemberChanged = z.infer<typeof memberChangedSchema>;
export type ChannelUpdated = z.infer<typeof channelUpdatedSchema>;
export type MessageSendAck = z.infer<typeof messageSendAckSchema>;
export type JoinAck = z.infer<typeof joinAckSchema>;
export type SocketError = z.infer<typeof socketErrorSchema>;

/**
 * Every seq that appears in a payload, for the gap detector.
 *
 * Exported so `services/sequencing` can be given a message without importing the
 * whole contract, and so the one place that knows a message's ordering key is
 * called `seq` is this file.
 */
export const seqOf = (message: { seq: number }): number => seqSchema.parse(message.seq);
