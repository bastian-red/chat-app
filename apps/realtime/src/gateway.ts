/**
 * The Socket.io gateway: the process that scales horizontally.
 *
 * Four properties, each with the mechanism that holds it.
 *
 * **1. A message sent through this replica reaches a client on another one.**
 * `@socket.io/redis-adapter`, wired over the two connections `boot.ts` opened.
 * That is the whole of the "scaling" half of the brief, and it is also the half
 * that is easy to fake: with one process every socket shares an in-memory adapter
 * and broadcasts work whether or not the adapter is wired at all, which is why
 * `scripts/integration.sh` starts two.
 *
 * **2. Nobody writes into a channel they are not in.** The permission matrix is
 * checked here, before `services/messaging` is called, and again inside that
 * module's own transaction. The check here is what stops a socket event costing a
 * transaction; the check there is what makes the removal of a member atomic with
 * respect to their in-flight send. Two checks, one matrix.
 *
 * **3. A refused frame is cheap.** `dispatch` runs the rate limiter before it
 * parses, so a client in a loop costs a Map lookup rather than a zod parse and a
 * database round trip.
 *
 * **4. An unauthenticated socket never gets a session.** The handshake is verified
 * in `io.use()` middleware and a failure is a *close*, not a `server.error`: there
 * is no session to send an error to, and answering an application-level error to a
 * socket that was never authenticated invites a client to retry forever.
 *
 * ---------------------------------------------------------------------------
 * Two things that look like details and are not
 *
 * **Presence is cleaned up on `disconnecting`, not `disconnect`.** By the time
 * `disconnect` fires, Socket.io has already emptied `socket.rooms`, so a handler
 * there has nothing to iterate and every channel the socket was in keeps its
 * roster entry until the TTL sweeps it. The roster would be right eventually and
 * wrong for `PRESENCE_TTL_SECONDS` after every single tab close.
 *
 * **The author is excluded from the `message.new` fan-out.** Their client learns
 * the allocated seq from the ack, so a second delivery is a duplicate the reorder
 * buffer discards on every send. `ChannelBroadcast.messageNew` takes the recipient
 * list for exactly this, and `services/messaging` returns it already filtered.
 */
import { createAdapter } from '@socket.io/redis-adapter';
import { PresenceStore } from '@chat/presence';
import {
  MessagingError,
  attachmentUrl,
  deleteMessage,
  editMessage,
  loadChannelView,
  markRead,
  presentMessage,
  sendMessage,
  type MessagingRepository,
} from '@chat/messaging';
import {
  CLIENT_EVENTS,
  ChannelBroadcast,
  SERVER_EVENTS,
  can,
  channelCatchUpPayloadSchema,
  channelIdFromRoom,
  channelJoinSchema,
  channelLeaveSchema,
  channelRoom,
  handshakeAuthSchema,
  messageDeletePayloadSchema,
  messageEditPayloadSchema,
  messageReadPayloadSchema,
  messageSendPayloadSchema,
  presencePingPayloadSchema,
  typingPayloadSchema,
  userRoom,
  type Ack,
  type ChannelView,
  type JoinAck,
  type Message,
  type MessageSendAck,
  type PresenceState,
} from '@chat/shared';
// The `/server` entry point, not the root one. `@chat/shared` is bundled for the
// browser and must never reach `jsonwebtoken`; the split is what keeps a token
// verifier out of the client bundle.
import { verifyServiceToken, type TokenUser } from '@chat/shared/server';
import { isDuplicateClientMessage, isSeqCollision } from '@chat/db';
import type { Server as HttpServer } from 'node:http';
import { Server, type DefaultEventsMap, type Socket } from 'socket.io';

import type { RealtimeConfig } from './config';
import type { Connections } from './boot';
import { boundCatchUp, dispatch, type DispatchDeps } from './dispatch';
import { SocketLimiters } from './rate-limit';

/**
 * What the handshake proved, hung off the socket.
 *
 * Socket.io's `data` bag rather than a Map keyed by socket id: the bag is freed
 * with the socket, and a Map is a leak waiting for the one disconnect path
 * somebody forgets.
 */
interface SocketData {
  user: TokenUser;
}

/**
 * The socket, typed for its `data` bag and for nothing else.
 *
 * Socket.io's first three generics want one method signature per event name.
 * Writing them out would be a second declaration of the protocol beside
 * `packages/shared/src/contracts/events.ts`, and two declarations of one protocol
 * is the failure this codebase spends the most effort avoiding: they agree until
 * one of them changes, and the one that changes is never the one you are reading.
 *
 * `DefaultEventsMap` is Socket.io's own open map, so the library keeps its
 * signatures and the payloads stay typed where it actually matters -- every
 * handler below parses its input with a contract schema before touching it, and
 * every `emit` passes a value a contract produced.
 */
type ChatSocket = Socket<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>;

export interface GatewayDeps {
  config: RealtimeConfig;
  connections: Connections;
  repository: MessagingRepository;
  httpServer: HttpServer;
}

export interface Gateway {
  io: Server;
  presence: PresenceStore;
  counts: () => { connectedSockets: number; rooms: number };
  close: () => Promise<void>;
}

/**
 * The classifier `services/messaging` uses to tell a duplicate from a collision.
 *
 * Both predicates come from `@chat/db`, which matches on the **constraint name**
 * and never on the message text: Postgres localises and rewords error messages
 * between versions, so a `String(error).includes('duplicate key')` is a check that
 * stops working on a server with a Spanish locale and reports the failure as a
 * 500 on somebody's second attempt to send one message.
 */
const CLASSIFIER = { isDuplicateClientMessage, isSeqCollision };

export function createGateway(deps: GatewayDeps): Gateway {
  const { config, connections, repository, httpServer } = deps;

  const io = new Server(httpServer, {
    // The frame ceiling, distinct from the 4000-character body limit in the
    // contract. Two different checks and both are needed: the body limit produces
    // a message a person can act on, this one closes a connection sending frames
    // nobody asked for.
    maxHttpBufferSize: config.socketMaxPayloadBytes,
    // The web app runs on a different origin in development (:3000 against
    // :4100). Named rather than `*`, so a page on a host nobody vetted cannot
    // open an authenticated socket with a token it phished.
    cors: { origin: config.appBaseUrl, credentials: true },
  });

  io.adapter(createAdapter(connections.pub, connections.sub));

  // The adapter's publisher, reused. It is the connection that is *not* in
  // subscriber mode, so ordinary commands work on it; `connections.sub` has
  // issued SUBSCRIBE and would refuse every HSET the roster needs. A third
  // connection would be a third thing to fail and a third error listener to
  // forget.
  const presence = new PresenceStore(connections.pub, {
    heartbeatSeconds: config.presenceHeartbeatSeconds,
    ttlSeconds: config.presenceTtlSeconds,
    typingTtlSeconds: config.typingTtlSeconds,
  });

  const broadcast = new ChannelBroadcast(io, {
    // A failed emit must not fail a write that already committed: the row is in
    // Postgres with its seq, and a client that missed the frame notices the gap
    // and catches up. Logging it is all that is left to do.
    onFailure: (event, error) => {
      console.error(`[realtime] broadcast failed for ${event}`, error);
    },
  });

  const limiters = new SocketLimiters(config.socketEventRateLimit);

  // --- handshake ------------------------------------------------------------

  io.use((socket, next) => {
    const parsed = handshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) {
      next(new Error('A token is required to open a socket.'));
      return;
    }

    const result = verifyServiceToken(parsed.data.token, config.authSecret);
    if (!result.ok) {
      // The reason (`expired` versus `signature`) goes to the log and not to the
      // client: telling a caller which half of the token to keep working on is a
      // hint nobody legitimate needs.
      console.warn(`[realtime] handshake rejected: ${result.reason}`);
      next(new Error('That token was not accepted.'));
      return;
    }

    (socket as ChatSocket).data.user = result.user;
    next();
  });

  // --- connection -----------------------------------------------------------

  io.on('connection', (raw) => {
    const socket = raw as ChatSocket;
    const user = socket.data.user;

    // The user room, immediately and unconditionally. It is what makes a DM
    // arriving in a conversation the recipient does not have open still bump
    // their sidebar, and a mention light up a channel they are not looking at.
    void socket.join(userRoom(user.id));

    const deps: DispatchDeps = {
      limiter: limiters.for(socket.id),
      onInternal: (event, error) => {
        console.error(`[realtime] ${event} failed`, error);
      },
    };

    /** Membership plus role, or a `MessagingError` the dispatcher maps for us. */
    const requireRole = async (channelId: string) => {
      const member = await repository.member(channelId, user.id);
      if (!member) throw new MessagingError('FORBIDDEN', 'You are not in that channel.');
      return member;
    };

    const rosterOf = async (channelId: string): Promise<Map<string, PresenceState>> => {
      const roster = await presence.roster(channelId);
      return new Map(roster.map((entry) => [entry.userId, entry.state]));
    };

    /** Re-read the roster and tell everybody. Always the complete set. */
    const publishPresence = async (channelId: string): Promise<void> => {
      const roster = await presence.roster(channelId);
      broadcast.presenceChanged(
        channelId,
        roster.map((entry) => ({
          userId: entry.userId,
          name: entry.name,
          initials: entry.initials,
          state: entry.state,
        })),
      );
    };

    const publishTyping = async (channelId: string): Promise<void> => {
      broadcast.typingChanged(channelId, await presence.typing(channelId));
    };

    // --- channel.join -------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.channelJoin,
      (payload: unknown, ack?: (result: Ack<JoinAck>) => void) => {
        void answer(
          CLIENT_EVENTS.channelJoin,
          payload,
          channelJoinSchema,
          async ({ channelId }) => {
            const member = await requireRole(channelId);
            if (!can(member.role, 'channel.read')) {
              throw new MessagingError('FORBIDDEN', 'You cannot read that channel.');
            }

            await socket.join(channelRoom(channelId));
            await presence.touch(channelId, socket.id, { userId: user.id, name: user.name });

            const view: ChannelView = await loadChannelView(repository, {
              channelId,
              userId: user.id,
              limit: config.historyPageSize,
              presence: await rosterOf(channelId),
            });

            // The whole channel to the joiner alone, then the roster to everybody.
            // Two events rather than one: the joiner needs state nobody else does
            // (their own read marker, their page of history), and the others need
            // only the fact that somebody arrived.
            socket.emit(SERVER_EVENTS.channelState, view);
            await publishPresence(channelId);

            return { lastSeq: view.lastSeq };
          },
          ack,
        );
      },
    );

    // --- channel.leave ------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.channelLeave,
      (payload: unknown, ack?: (result: Ack<object>) => void) => {
        void answer(
          CLIENT_EVENTS.channelLeave,
          payload,
          channelLeaveSchema,
          async ({ channelId }) => {
            await socket.leave(channelRoom(channelId));
            await presence.leave(channelId, socket.id);
            await presence.stopTyping(channelId, user.id);
            await publishPresence(channelId);
            await publishTyping(channelId);
            return {};
          },
          ack,
        );
      },
    );

    // --- message.send -------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.messageSend,
      (payload: unknown, ack?: (result: Ack<MessageSendAck>) => void) => {
        void answer(
          CLIENT_EVENTS.messageSend,
          payload,
          messageSendPayloadSchema,
          async (input) => {
            // Checked here as well as inside `sendMessage`'s transaction. This
            // one keeps a refusal off the database entirely; that one makes the
            // check atomic with the write.
            const member = await requireRole(input.channelId);
            if (!can(member.role, 'message.send')) {
              throw new MessagingError('FORBIDDEN', 'You cannot post in this channel.');
            }

            const result = await sendMessage(
              repository,
              {
                channelId: input.channelId,
                authorId: user.id,
                clientMessageId: input.clientMessageId,
                body: input.body,
                attachmentIds: input.attachmentIds,
              },
              { attempts: config.sendRetryAttempts, classify: CLASSIFIER },
            );

            const message: Message = presentMessage(result.message, { attachmentUrl });

            // Not broadcast on a duplicate. The message is already on every
            // client that was going to receive it; re-emitting would push a
            // second copy of a line everyone can see, which the reorder buffer
            // then has to discard on a path where nothing went wrong.
            if (!result.duplicate) {
              // `except(socket.id)`, and this is the only broadcast that needs it.
              //
              // `result.recipients` already excludes the author from the user-room
              // fan-out, but the **channel room** contains the author's own socket:
              // they are reading the conversation they just wrote into. The ack of
              // this very event carries the message with its allocated seq, so a
              // channel-room delivery would be the same message arriving twice on
              // one client, on every single send. The reorder buffer would discard
              // it, which means the bug is invisible and the cost is a wasted frame
              // per send per sender.
              //
              // `io.except()` returns a BroadcastOperator, which satisfies
              // `RoomEmitter` structurally -- the reason that interface is
              // structural rather than typed to `Server`.
              const authored = new ChannelBroadcast(io.except(socket.id), {
                onFailure: (event, error) => {
                  console.error(`[realtime] broadcast failed for ${event}`, error);
                },
              });
              authored.messageNew(input.channelId, message, result.recipients);
            }

            // Typing stops when a message lands. Without this the indicator sits
            // there for TYPING_TTL_SECONDS after the sentence it was announcing
            // has already been read, which is a lie about who is mid-word.
            await presence.stopTyping(input.channelId, user.id);
            await publishTyping(input.channelId);

            return { message, duplicate: result.duplicate };
          },
          ack,
        );
      },
    );

    // --- message.edit -------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.messageEdit,
      (payload: unknown, ack?: (result: Ack<object>) => void) => {
        void answer(
          CLIENT_EVENTS.messageEdit,
          payload,
          messageEditPayloadSchema,
          async (input) => {
            const row = await editMessage(repository, {
              channelId: input.channelId,
              messageId: input.messageId,
              actorId: user.id,
              body: input.body,
            });
            broadcast.messageUpdated(input.channelId, presentMessage(row, { attachmentUrl }));
            return {};
          },
          ack,
        );
      },
    );

    // --- message.delete -----------------------------------------------------

    socket.on(
      CLIENT_EVENTS.messageDelete,
      (payload: unknown, ack?: (result: Ack<object>) => void) => {
        void answer(
          CLIENT_EVENTS.messageDelete,
          payload,
          messageDeletePayloadSchema,
          async (input) => {
            const row = await deleteMessage(repository, {
              channelId: input.channelId,
              messageId: input.messageId,
              actorId: user.id,
            });
            // The whole tombstone, not the id. The row still exists and still
            // holds its seq; sending only the id would make each client invent
            // the tombstone, and a client that invents state can invent it
            // differently from the server.
            broadcast.messageDeleted(input.channelId, presentMessage(row, { attachmentUrl }));
            return {};
          },
          ack,
        );
      },
    );

    // --- message.read -------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.messageRead,
      (payload: unknown, ack?: (result: Ack<{ seq: number }>) => void) => {
        void answer(
          CLIENT_EVENTS.messageRead,
          payload,
          messageReadPayloadSchema,
          async (input) => {
            // What the server stored, which can be lower than what was asked for:
            // the marker only moves forward, so a stale request from a second tab
            // is a no-op and the ack corrects the client rather than rolling
            // anybody's marker back.
            const seq = await markRead(repository, {
              channelId: input.channelId,
              userId: user.id,
              seq: input.seq,
            });
            broadcast.readChanged(input.channelId, user.id, seq);
            return { seq };
          },
          ack,
        );
      },
    );

    // --- channel.catchup ----------------------------------------------------

    socket.on(
      CLIENT_EVENTS.channelCatchUp,
      (payload: unknown, ack?: (result: Ack<unknown>) => void) => {
        void answer(
          CLIENT_EVENTS.channelCatchUp,
          payload,
          channelCatchUpPayloadSchema,
          async (input) => {
            await requireRole(input.channelId);

            const channel = await repository.channel(input.channelId);
            if (!channel) throw new MessagingError('NOT_FOUND', 'That channel does not exist.');

            // One more than the ceiling, so "exactly at the ceiling" and "more than
            // the ceiling" are distinguishable. See `boundCatchUp`.
            const fetched = await repository.forward({
              channelId: input.channelId,
              afterSeq: input.afterSeq,
              limit: config.catchUpMaxMessages + 1,
            });

            const bounded = boundCatchUp(fetched, config.catchUpMaxMessages);
            return {
              messages: bounded.messages.map((row) => presentMessage(row, { attachmentUrl })),
              complete: bounded.complete,
              lastSeq: Math.max(0, channel.nextSeq - 1),
            };
          },
          ack,
        );
      },
    );

    // --- typing -------------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.typingStart,
      (payload: unknown, ack?: (result: Ack<object>) => void) => {
        void answer(
          CLIENT_EVENTS.typingStart,
          payload,
          typingPayloadSchema,
          async ({ channelId }) => {
            const member = await requireRole(channelId);
            if (!can(member.role, 'typing.emit')) {
              throw new MessagingError('FORBIDDEN', 'You cannot type in that channel.');
            }
            await presence.startTyping(channelId, { userId: user.id, name: user.name });
            await publishTyping(channelId);
            return {};
          },
          ack,
        );
      },
    );

    socket.on(CLIENT_EVENTS.typingStop, (payload: unknown, ack?: (result: Ack<object>) => void) => {
      void answer(
        CLIENT_EVENTS.typingStop,
        payload,
        typingPayloadSchema,
        async ({ channelId }) => {
          await presence.stopTyping(channelId, user.id);
          await publishTyping(channelId);
          return {};
        },
        ack,
      );
    });

    // --- presence.ping ------------------------------------------------------

    socket.on(
      CLIENT_EVENTS.presencePing,
      (payload: unknown, ack?: (result: Ack<object>) => void) => {
        void answer(
          CLIENT_EVENTS.presencePing,
          payload,
          presencePingPayloadSchema,
          async ({ channelId, activity }) => {
            const member = await requireRole(channelId);
            if (!can(member.role, 'presence.join')) {
              throw new MessagingError('FORBIDDEN', 'You are not in that channel.');
            }
            await presence.touch(
              channelId,
              socket.id,
              { userId: user.id, name: user.name },
              activity,
            );
            // Broadcast, not silent. A heartbeat is how somebody goes from `away`
            // back to `online`, and a roster nobody is told about is a roster
            // every client shows a stale version of until it happens to rejoin.
            await publishPresence(channelId);
            return {};
          },
          ack,
        );
      },
    );

    // --- teardown -----------------------------------------------------------

    // `disconnecting`, not `disconnect`. See the module header: `socket.rooms` is
    // already empty by the time `disconnect` fires, so the loop below would find
    // nothing and every roster would keep a dead entry for a full TTL.
    socket.on('disconnecting', () => {
      const rooms = [...socket.rooms];
      void (async () => {
        for (const room of rooms) {
          // `channelIdFromRoom`, never a `startsWith` here. Socket.io puts every
          // socket into a room named after its own id, and every authenticated
          // socket into `user:<id>`, so an unfiltered loop would treat a socket
          // id as a channel and write presence against a channel that does not
          // exist.
          const channelId = channelIdFromRoom(room);
          if (channelId === null) continue;
          try {
            await presence.leave(channelId, socket.id);
            await presence.stopTyping(channelId, user.id);
            await publishPresence(channelId);
            await publishTyping(channelId);
          } catch (error) {
            // A teardown failure must not become an unhandled rejection: this
            // runs on the gateway, where that takes every other socket on the
            // replica down with it. The TTL sweeps whatever this missed.
            console.error('[realtime] presence cleanup failed', error);
          }
        }
      })();
    });

    socket.on('disconnect', () => {
      // The limiter outlives the socket otherwise, and a gateway that never
      // forgot a disconnected socket would hold a timestamp array per connection
      // it had ever served.
      limiters.forget(socket.id);
    });

    /**
     * Hand a dispatch result to the ack, or to `server.error` when there is none.
     *
     * A client that omitted its ack callback still has to learn it was refused.
     * Without this branch a rate-limited fire-and-forget event is silently
     * dropped, which from the client's seat is indistinguishable from the server
     * accepting it.
     */
    async function answer<TPayload, TResult>(
      event: string,
      payload: unknown,
      schema: Parameters<typeof dispatch<TPayload, TResult>>[2],
      handler: (input: TPayload) => Promise<TResult>,
      ack?: (result: Ack<TResult>) => void,
    ): Promise<void> {
      const result = await dispatch(event, payload, schema, handler, deps);
      if (typeof ack === 'function') {
        ack(result);
        return;
      }
      if (!result.ok) socket.emit(SERVER_EVENTS.error, result.error);
    }
  });

  return {
    io,
    presence,
    counts: () => ({
      // `io.sockets.sockets` is this replica's own map. Deliberately local: the
      // number a reader wants from a health endpoint is how many sockets *this*
      // process is holding, and an adapter-wide count would make two replicas
      // report the same figure and hide an idle one.
      connectedSockets: io.sockets.sockets.size,
      rooms: io.sockets.adapter.rooms.size,
    }),
    close: async () => {
      // Order matters. `io.close()` stops accepting, closes every socket and
      // closes the underlying HTTP server; doing it before the Redis connections
      // go means no broadcast is attempted against a client that is already gone.
      await new Promise<void>((resolve) => {
        io.close(() => {
          resolve();
        });
      });
    },
  };
}
