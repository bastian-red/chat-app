import { describe, expect, it } from 'vitest';

import { ChannelBroadcast, type RoomEmitter } from './broadcast';
import type { Member, Message } from './contracts/channel';
import { SERVER_EVENTS } from './contracts/events';
import { channelRoom, userRoom } from './rooms';

interface Sent {
  room: string;
  event: string;
  payload: unknown;
}

/**
 * A recording emitter.
 *
 * Structural, exactly like the two real ones: `socket.io`'s `Server` and
 * `@socket.io/redis-emitter`'s `Emitter` both satisfy `RoomEmitter`, and this
 * satisfies it too without either package being installed. That is the point of
 * the interface -- if this test needed socket.io, so would the browser bundle.
 */
function recorder(): { emitter: RoomEmitter; sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    emitter: {
      to: (room: string) => ({
        emit: (event: string, payload: unknown) => sent.push({ room, event, payload }),
      }),
    },
  };
}

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'm1',
  channelId: 'c1',
  seq: 7,
  author: { id: 'u-ana', name: 'Ana Ruiz', initials: 'AR' },
  clientMessageId: 'client-0000001',
  body: 'Shipping the release notes',
  createdAt: '2026-08-11T09:00:00.000Z',
  editedAt: null,
  deletedAt: null,
  attachments: [],
  mentions: [],
  ...overrides,
});

const member = (userId: string, name: string): Member => ({
  userId,
  name,
  email: `${userId}@chat.local`,
  initials: name
    .split(' ')
    .map((part) => part[0])
    .join(''),
  role: 'MEMBER',
  presence: 'online',
});

describe('a new message', () => {
  it('reaches the channel room', () => {
    const { emitter, sent } = recorder();
    new ChannelBroadcast(emitter).messageNew('c1', message(), []);

    expect(sent).toEqual([
      { room: channelRoom('c1'), event: SERVER_EVENTS.messageNew, payload: { message: message() } },
    ]);
  });

  it('also reaches each recipient s own room', () => {
    // The part that is easy to leave out, and whose absence is invisible: a
    // message must bump the sidebar of somebody reading a *different* channel,
    // and those people are by definition not in the channel room. Broadcasting
    // only to the channel reaches exactly the set who can already see it.
    const { emitter, sent } = recorder();
    new ChannelBroadcast(emitter).messageNew('c1', message(), ['u-bruno', 'u-carla']);

    expect(sent.map((entry) => entry.room)).toEqual([
      channelRoom('c1'),
      userRoom('u-bruno'),
      userRoom('u-carla'),
    ]);
  });

  it('does not send the author their own message a second time', () => {
    // The caller passes members-minus-author. The author's client learns the seq
    // from its ack, so a copy here would be a duplicate the reorder buffer has to
    // discard on every single send.
    const { emitter, sent } = recorder();
    new ChannelBroadcast(emitter).messageNew('c1', message(), ['u-bruno']);

    expect(sent.some((entry) => entry.room === userRoom('u-ana'))).toBe(false);
  });
});

describe('a deletion', () => {
  it('carries the whole tombstone, not just an id', () => {
    // The row still exists and still holds its seq -- a hole in the sequence is
    // indistinguishable from a message a client has not received yet. Sending only
    // the id would make each client invent the tombstone, and a client that
    // invents state can invent it differently from the server.
    const { emitter, sent } = recorder();
    const tombstone = message({ body: '', deletedAt: '2026-08-11T09:05:00.000Z' });
    new ChannelBroadcast(emitter).messageDeleted('c1', tombstone);

    expect(sent[0]?.payload).toEqual({ message: tombstone });
    expect((sent[0]?.payload as { message: Message }).message.seq).toBe(7);
  });
});

describe('membership', () => {
  it('tells the channel and the person who was added', () => {
    // Somebody added to a private channel is not in its room yet -- that is what
    // being added means -- so a channel-only broadcast tells everyone except the
    // one whose sidebar needs a new row.
    const { emitter, sent } = recorder();
    const members = [member('u-ana', 'Ana Ruiz'), member('u-bruno', 'Bruno Salas')];
    new ChannelBroadcast(emitter).memberChanged('c1', members, ['u-bruno']);

    expect(sent.map((entry) => entry.room)).toEqual([channelRoom('c1'), userRoom('u-bruno')]);
  });
});

describe('typing', () => {
  it('sends the whole set, so every broadcast is a correction', () => {
    // A delta would require each client to hold a set that can drift and never
    // repair itself: one missed "stopped" leaves somebody typing forever.
    const { emitter, sent } = recorder();
    new ChannelBroadcast(emitter).typingChanged('c1', [{ userId: 'u-ana', name: 'Ana Ruiz' }]);

    expect(sent[0]?.payload).toEqual({
      channelId: 'c1',
      typing: [{ userId: 'u-ana', name: 'Ana Ruiz' }],
    });
  });

  it('sends an empty set rather than nothing when the last typist stops', () => {
    // "Nobody is typing" is a state that has to be transmitted. Skipping the
    // empty broadcast is how an indicator gets stuck on somebody who left.
    const { emitter, sent } = recorder();
    new ChannelBroadcast(emitter).typingChanged('c1', []);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({ channelId: 'c1', typing: [] });
  });

  it('copies the array it was handed', () => {
    // The caller usually owns a set it is about to mutate. Emitting the same
    // reference means a later `.push()` edits a payload that has already been
    // "sent" -- which is invisible with a real emitter that serialises
    // immediately, and wrong with any that does not.
    const { emitter, sent } = recorder();
    const typing = [{ userId: 'u-ana', name: 'Ana Ruiz' }];
    new ChannelBroadcast(emitter).typingChanged('c1', typing);
    typing.push({ userId: 'u-bruno', name: 'Bruno Salas' });

    expect((sent[0]?.payload as { typing: unknown[] }).typing).toHaveLength(1);
  });
});

describe('a failing transport', () => {
  it('does not throw into the caller', () => {
    // The write has already committed. Letting the throw escape would turn "the
    // broadcast failed" into "the send failed", and the user would retry a
    // message that is already stored.
    const failing: RoomEmitter = {
      to: () => ({
        emit: () => {
          throw new Error('redis is gone');
        },
      }),
    };

    expect(() => new ChannelBroadcast(failing).messageNew('c1', message(), [])).not.toThrow();
  });

  it('reports the failure to the caller that asked to hear about it', () => {
    const failures: string[] = [];
    const failing: RoomEmitter = {
      to: () => ({
        emit: () => {
          throw new Error('redis is gone');
        },
      }),
    };

    new ChannelBroadcast(failing, {
      onFailure: (event) => failures.push(event),
    }).messageNew('c1', message(), ['u-bruno']);

    // Once per room, because each is its own emit and a partial outage is a real
    // shape: the channel room delivered and the user room did not.
    expect(failures).toEqual([SERVER_EVENTS.messageNew, SERVER_EVENTS.messageNew]);
  });

  it('is silent by default, because the browser imports this', () => {
    // A library that logs on its own is a library the application cannot
    // quieten, and this module is in the web bundle.
    const failing: RoomEmitter = {
      to: () => ({
        emit: () => {
          throw new Error('redis is gone');
        },
      }),
    };

    expect(() => new ChannelBroadcast(failing).typingChanged('c1', [])).not.toThrow();
  });
});
