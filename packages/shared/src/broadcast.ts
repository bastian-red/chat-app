/**
 * Turning a write into a broadcast, once, for both processes that do writes.
 *
 * The gateway holds a `socket.io` `Server`; the REST API holds a
 * `@socket.io/redis-emitter` `Emitter` and no server at all. Those are different
 * objects from different packages, but the call they need is the same shape --
 * `.to(room).emit(name, payload)` -- so this module takes that shape as an
 * interface and neither imports socket.io nor drags it into the browser bundle.
 *
 * Why it is shared rather than written twice: **a REST send and a socket send are
 * the same write**, and they must produce the same event, in the same room, with
 * the same payload. Two implementations of that mapping disagree eventually, and
 * the way this one fails is silent -- the other client simply never sees the
 * message, which is indistinguishable from a dropped connection.
 *
 * So the methods take *domain objects* and build the wire payload here. A caller
 * that had to assemble the envelope itself is a caller that can broadcast a
 * message into the wrong channel's room, and every client in that room would then
 * render a line from a conversation they are not in.
 *
 * Every method is fire-and-forget by design. A broadcast that fails must not fail
 * the write that already committed: the row is in Postgres with its seq, and a
 * client that missed the event notices the gap and catches up. `onFailure` exists
 * so the caller can log that rather than swallow it.
 */
import type { Member, Message } from './contracts/channel';
import { SERVER_EVENTS } from './contracts/events';
import type { PresenceState } from './contracts/primitives';
import { channelRoom, userRoom } from './rooms';

/**
 * The one method both emitters have.
 *
 * Structural rather than nominal on purpose: `socket.io`'s `Server` and
 * `@socket.io/redis-emitter`'s `Emitter` both satisfy it, and neither package is
 * a dependency of `@chat/shared`.
 */
export interface RoomEmitter {
  to(room: string): { emit(event: string, payload: unknown): unknown };
}

export interface BroadcastOptions {
  /**
   * Called when an emit throws. Not `console.error` by default: this package is
   * imported by the browser bundle, and a library that logs on its own is a
   * library the application cannot quieten.
   */
  onFailure?: (event: string, error: unknown) => void;
}

export class ChannelBroadcast {
  constructor(
    private readonly emitter: RoomEmitter,
    private readonly options: BroadcastOptions = {},
  ) {}

  /**
   * A new message, to everybody with the channel open.
   *
   * And separately to each recipient's **user room**, which is the part that is
   * easy to leave out. A message must bump the sidebar of somebody who is reading
   * a different channel -- unread counts, DM notifications, mentions -- and those
   * people are by definition not in the channel room. Broadcasting only to the
   * channel reaches exactly the set of people who can already see it.
   *
   * `recipients` is the channel's membership minus the author. The author's own
   * client learns the seq from its ack, so sending it again would be a duplicate
   * the reorder buffer has to discard on every single send.
   */
  messageNew(channelId: string, message: Message, recipients: readonly string[]): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.messageNew, { message });
    for (const userId of recipients) {
      this.emit(userRoom(userId), SERVER_EVENTS.messageNew, { message });
    }
  }

  messageUpdated(channelId: string, message: Message): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.messageUpdated, { message });
  }

  /**
   * A deletion, as the tombstone it left behind.
   *
   * The whole message rather than its id: the row still exists, still holds its
   * seq, and now has an empty body and a `deletedAt`. Sending only the id would
   * make each client invent the tombstone, and a client that invents state is a
   * client that can invent it differently from the server.
   */
  messageDeleted(channelId: string, message: Message): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.messageDeleted, { message });
  }

  /**
   * Somebody's read marker moved.
   *
   * To the channel room only. A read receipt is interesting to people looking at
   * the conversation and to nobody else, and pushing it to every member's user
   * room would make an idle client receive an event per message per reader.
   */
  readChanged(channelId: string, userId: string, seq: number): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.readChanged, { channelId, userId, seq });
  }

  /**
   * Who is typing, as the whole set.
   *
   * A join/leave delta would require every client to hold a set that can drift
   * and never repair itself: one missed "stopped" leaves somebody typing forever.
   * The set is small by construction -- bounded by the membership and by a
   * five-second TTL -- so sending all of it makes every broadcast a complete
   * correction rather than an increment.
   */
  typingChanged(channelId: string, typing: readonly { userId: string; name: string }[]): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.typingChanged, {
      channelId,
      typing: [...typing],
    });
  }

  presenceChanged(
    channelId: string,
    members: readonly { userId: string; name: string; initials: string; state: PresenceState }[],
  ): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.presenceChanged, {
      channelId,
      members: [...members],
    });
  }

  /**
   * The membership changed.
   *
   * To the channel room, and to the user room of whoever was added or removed.
   * Somebody added to a private channel is not in its room yet -- that is what
   * being added means -- so a channel-only broadcast tells everyone except the
   * person whose sidebar needs a new row.
   */
  memberChanged(channelId: string, members: readonly Member[], affected: readonly string[]): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.memberChanged, {
      channelId,
      members: [...members],
    });
    for (const userId of affected) {
      this.emit(userRoom(userId), SERVER_EVENTS.memberChanged, {
        channelId,
        members: [...members],
      });
    }
  }

  /**
   * A rename or a topic edit.
   *
   * The one event only `apps/api` emits: it happens from a settings form where no
   * socket for that channel need be open, and it reaches everybody who does have
   * it open through the Redis emitter rather than through a Socket.io server the
   * API does not run.
   */
  channelUpdated(channelId: string, name: string | null, topic: string | null): void {
    this.emit(channelRoom(channelId), SERVER_EVENTS.channelUpdated, { channelId, name, topic });
  }

  /**
   * The one place an emit actually happens.
   *
   * Wrapped so a transport failure cannot roll back a write that has already
   * committed. The message is in Postgres with its sequence number; a client that
   * missed the frame sees the gap on its next arrival and catches up. Letting the
   * throw escape would turn "the broadcast failed" into "the send failed", and the
   * user would retry a message that was already stored.
   */
  private emit(room: string, event: string, payload: unknown): void {
    try {
      this.emitter.to(room).emit(event, payload);
    } catch (error) {
      this.options.onFailure?.(event, error);
    }
  }
}
