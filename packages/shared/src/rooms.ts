/**
 * Socket.io room names.
 *
 * One function, shared, because **three processes have to agree on this string
 * and none of them can see the others**. The gateway puts a socket into a room on
 * `channel.join`; the gateway broadcasts into it after a socket-driven write; the
 * REST API broadcasts into it, from a different process entirely, through the
 * Redis emitter. A hand-written `` `channel:${id}` `` in any one of them that
 * drifts by a character produces no error anywhere: the write succeeds, the emit
 * succeeds, and the message is delivered to a room nobody is in.
 *
 * That is the worst failure shape in this whole codebase, because every layer
 * reports success and the only symptom is a conversation that does not update for
 * the other person -- which is indistinguishable, from the outside, from the
 * socket being down.
 *
 * The prefixes are spelled out rather than templated from a constant so a reader
 * searching Redis with `PUBSUB CHANNELS` finds the same characters they read
 * here.
 */

/** The room every member of one channel is in while they have it open. */
export function channelRoom(channelId: string): string {
  return `channel:${channelId}`;
}

/**
 * The channel a room name refers to, or null when the name is not a channel room.
 *
 * Socket.io puts every socket in a room named after its own id, so iterating a
 * socket's rooms without this filter finds the socket id and treats it as a
 * channel. Returning null rather than stripping a prefix blindly is what keeps
 * that from becoming a presence entry against a channel called `abc123XYZ`.
 */
export function channelIdFromRoom(room: string): string | null {
  return room.startsWith('channel:') ? room.slice('channel:'.length) || null : null;
}

/**
 * The room a single person is in, on every socket they have open.
 *
 * A second room kind, which the sibling project did not need. A chat has to
 * deliver to a *person* rather than to a conversation: a DM arriving in a channel
 * the recipient does not have open still has to bump their sidebar, and a mention
 * has to light up a channel they are not looking at. Broadcasting that into the
 * channel room would reach only the people already reading it -- which is
 * precisely the set who do not need to be told.
 *
 * Distinct prefix, and the same reasoning about it being spelled out. `user:` and
 * `channel:` can never collide even if an id from one namespace were reused in
 * the other.
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function userIdFromRoom(room: string): string | null {
  return room.startsWith('user:') ? room.slice('user:'.length) || null : null;
}
