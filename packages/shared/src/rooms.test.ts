import { describe, expect, it } from 'vitest';

import { channelIdFromRoom, channelRoom, userIdFromRoom, userRoom } from './rooms';

/**
 * These look trivial and they are the tests worth having.
 *
 * The failure this module exists to prevent leaves no trace: a broadcast into a
 * room nobody is in succeeds at every layer -- Redis publishes, the adapter
 * delivers, Socket.io iterates an empty set -- and the only symptom is that the
 * other person's window does not update. There is nothing in any log to find.
 */
describe('channel rooms', () => {
  it('is the literal prefix, not a template of a constant', () => {
    // Pinned as a string. A reader running `PUBSUB CHANNELS` against Redis has to
    // find these characters, and a test asserting `channelRoom(id).includes(id)`
    // would pass for every possible prefix including a renamed one.
    expect(channelRoom('c1')).toBe('channel:c1');
  });

  it('round-trips', () => {
    expect(channelIdFromRoom(channelRoom('c1'))).toBe('c1');
  });

  it('rejects a socket id rather than treating it as a channel', () => {
    // Socket.io puts every socket in a room named after its own id. Iterating
    // `socket.rooms` without this filter finds that id and, with a blind prefix
    // strip, records presence against a channel called `abc123XYZ`.
    expect(channelIdFromRoom('abc123XYZ')).toBeNull();
  });

  it('rejects the bare prefix', () => {
    // `'channel:'.slice(8)` is `''`, which is falsy but is still a string, and a
    // caller doing `if (id !== null)` would proceed with an empty channel id.
    expect(channelIdFromRoom('channel:')).toBeNull();
  });

  it('does not confuse the two namespaces', () => {
    expect(channelIdFromRoom(userRoom('u1'))).toBeNull();
    expect(userIdFromRoom(channelRoom('c1'))).toBeNull();
  });
});

describe('user rooms', () => {
  it('is the literal prefix', () => {
    expect(userRoom('u1')).toBe('user:u1');
  });

  it('round-trips', () => {
    expect(userIdFromRoom(userRoom('u1'))).toBe('u1');
  });

  it('rejects the bare prefix', () => {
    expect(userIdFromRoom('user:')).toBeNull();
  });
});
