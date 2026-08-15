/**
 * Who may do what in a channel.
 *
 * One table, in the one package every side imports. The API enforces it, the
 * realtime gateway enforces it before a socket event reaches services/messaging,
 * and the web app reads it to decide whether the composer is rendered at all.
 * Three enforcement points and one definition: a role that gains a capability
 * gains it everywhere at once, and a UI that offers an action the server will
 * refuse becomes impossible to write by accident.
 *
 * The alternative -- an `if (role === 'MEMBER')` at each call site -- is how
 * somebody ends up able to delete another person's message over the socket while
 * the REST route refuses them, because the two checks were written three weeks
 * apart.
 *
 * Deliberately pure data with no I/O: `can()` is a lookup, so it is safe to call
 * inside a render, inside a hot socket handler, and inside a Postgres
 * transaction.
 */

/**
 * The three roles, ordered from most to least powerful.
 *
 * Uppercase because these values are also the Postgres enum
 * (`packages/db/prisma/schema.prisma`), and a case difference between the
 * database and the contract is a bug that only appears once a real row exists.
 */
export const CHANNEL_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;

export type ChannelRole = (typeof CHANNEL_ROLES)[number];

/**
 * Every distinct thing a member can attempt.
 *
 * Named for the intent rather than for the HTTP route or the socket event, so one
 * capability covers both transports. `message.send` is the same permission
 * whether it arrives as `POST /channels/:id/messages` or as a `message.send`
 * socket event, and it must be, because both land in the same `sendMessage()`.
 *
 * The two `message.*.any` entries are the ones worth reading twice. Editing and
 * deleting **your own** message is not a role capability at all -- every member
 * has it, and it is checked against the author id rather than against this table.
 * What this table decides is who may act on somebody *else's* message, which is a
 * moderation power and is exactly the thing that must not be nested into "can
 * send".
 */
export const CHANNEL_OPERATIONS = [
  'channel.read',
  'channel.rename',
  'channel.delete',
  'channel.manageMembers',
  'message.send',
  'message.edit.own',
  'message.delete.own',
  'message.edit.any',
  'message.delete.any',
  'presence.join',
  'typing.emit',
] as const;

export type ChannelOperation = (typeof CHANNEL_OPERATIONS)[number];

/**
 * The matrix, written out in full rather than derived from a rank.
 *
 * A rank comparison (`roleRank[role] >= roleRank[required]`) is shorter and is
 * the wrong shape: it makes every capability strictly nested, so the first
 * permission that does not follow the hierarchy has to be special-cased outside
 * the model that was supposed to hold all of it. This product has such a case
 * already -- an ADMIN may delete anybody's message but may not delete the
 * channel, while an OWNER may do both -- and it is one line here instead of a
 * branch somewhere else.
 *
 * Frozen, not merely typed `readonly`: this table is imported by a React tree and
 * handed to callers by `operationsFor`, and `readonly` is erased at runtime. One
 * `.push()` in a component -- or in a caller that thought it owned the array it
 * was given -- would grant a permission process-wide, to every request the
 * process goes on to serve. `Object.freeze` makes that a TypeError instead, and
 * these modules are ESM, so it throws rather than failing silently.
 */
const MATRIX: Readonly<Record<ChannelRole, readonly ChannelOperation[]>> = Object.freeze({
  OWNER: Object.freeze([
    'channel.read',
    'channel.rename',
    'channel.delete',
    'channel.manageMembers',
    'message.send',
    'message.edit.own',
    'message.delete.own',
    'message.edit.any',
    'message.delete.any',
    'presence.join',
    'typing.emit',
  ] as const),
  // Everything an owner has except ending the channel. Moderation is a different
  // power from destruction, and an admin who can delete the room they moderate is
  // one misclick from ending a conversation nobody can recover.
  ADMIN: Object.freeze([
    'channel.read',
    'channel.rename',
    'channel.manageMembers',
    'message.send',
    'message.edit.own',
    'message.delete.own',
    'message.edit.any',
    'message.delete.any',
    'presence.join',
    'typing.emit',
  ] as const),
  // Note what is absent: `message.edit.any`. Nobody but a moderator may put words
  // in somebody else's mouth, and "edit any" is precisely that. `message.edit.own`
  // is present, and the author check that goes with it lives in services/messaging
  // rather than here, because this table knows about roles and not about rows.
  MEMBER: Object.freeze([
    'channel.read',
    'message.send',
    'message.edit.own',
    'message.delete.own',
    'presence.join',
    'typing.emit',
  ] as const),
});

/**
 * Pre-built sets, so `can()` is a hash lookup rather than a linear scan.
 *
 * Written out per role rather than derived with `Object.fromEntries`, which
 * returns `{ [k: string]: ... }` and has to be cast back to a
 * `Record<ChannelRole, ...>` -- a cast that would keep compiling if a role were
 * dropped from CHANNEL_ROLES, leaving `can()` to return false for it forever.
 * Three explicit keys means a fourth role is a compile error here.
 */
const ALLOWED: Readonly<Record<ChannelRole, ReadonlySet<ChannelOperation>>> = Object.freeze({
  OWNER: new Set<ChannelOperation>(MATRIX.OWNER),
  ADMIN: new Set<ChannelOperation>(MATRIX.ADMIN),
  MEMBER: new Set<ChannelOperation>(MATRIX.MEMBER),
});

/**
 * May a member with this role perform this operation?
 *
 * `role` is typed as `ChannelRole | null` because "not a member of this channel"
 * is the common case at the edge, not an exceptional one: an unauthenticated
 * socket, a link to a private channel, a member removed while their tab was open.
 * Making the caller narrow that first is how a null slips through as "truthy
 * enough" and grants everything.
 */
export function can(
  role: ChannelRole | null | undefined,
  operation: ChannelOperation,
): boolean {
  if (!role) return false;
  return ALLOWED[role]?.has(operation) ?? false;
}

/** Everything this role may do. A copy, so a caller cannot edit the table. */
export function operationsFor(role: ChannelRole): ChannelOperation[] {
  return [...MATRIX[role]];
}

/**
 * May this person act on this particular message?
 *
 * The one permission question that is not answerable from the role alone, and it
 * is here rather than in the service so that the web app asks it the same way the
 * gateway does. A member may edit their own line; a moderator may edit anybody's.
 * An author who has since been removed from the channel may do neither, which
 * falls out of `role` being null for them.
 *
 * `authorId` is nullable because a message outlives its author's account. Nobody
 * "owns" a message whose author is gone, so only `message.edit.any` reaches it --
 * which is the right answer: a deleted account's words are a moderation matter,
 * not an ownership one.
 */
export function canActOnMessage(
  role: ChannelRole | null | undefined,
  action: 'edit' | 'delete',
  actorId: string,
  authorId: string | null,
): boolean {
  if (!role) return false;
  if (can(role, action === 'edit' ? 'message.edit.any' : 'message.delete.any')) return true;
  if (authorId === null) return false;
  return (
    authorId === actorId &&
    can(role, action === 'edit' ? 'message.edit.own' : 'message.delete.own')
  );
}
