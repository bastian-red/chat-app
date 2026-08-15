import { describe, expect, it } from 'vitest';

import {
  CHANNEL_OPERATIONS,
  CHANNEL_ROLES,
  can,
  canActOnMessage,
  operationsFor,
  type ChannelOperation,
} from './roles';

/**
 * The permission matrix, asserted as a specification rather than spot-checked.
 *
 * Three enforcement points import this table -- the REST guard, the socket
 * handler and the React tree -- so a gap here is a gap in all three at once, and
 * the interesting failures are the ones nobody would think to spot-check: a role
 * silently gaining a capability because the array was edited in the wrong block.
 */
describe('the matrix covers everything, exactly once', () => {
  it('every operation is reachable by at least one role', () => {
    // An operation no role can perform is dead code that reads as a feature. It
    // has happened: a capability renamed in the list and not in the matrix.
    for (const operation of CHANNEL_OPERATIONS) {
      const holders = CHANNEL_ROLES.filter((role) => can(role, operation));
      expect(holders, `nobody can ${operation}`).not.toHaveLength(0);
    }
  });

  it('no role holds an operation that is not in the list', () => {
    const known = new Set<string>(CHANNEL_OPERATIONS);
    for (const role of CHANNEL_ROLES) {
      for (const operation of operationsFor(role)) {
        expect(known.has(operation), `${role} holds unknown ${operation}`).toBe(true);
      }
    }
  });

  it('owner holds every operation', () => {
    for (const operation of CHANNEL_OPERATIONS) {
      expect(can('OWNER', operation), `OWNER cannot ${operation}`).toBe(true);
    }
  });
});

describe('the deliberate non-nesting', () => {
  it('an admin moderates but cannot delete the channel', () => {
    // The case a rank comparison gets wrong. With `rank >= required`, an admin
    // who can delete anybody's message can necessarily delete the channel, and
    // the exception has to be special-cased outside the model.
    expect(can('ADMIN', 'message.delete.any')).toBe(true);
    expect(can('ADMIN', 'channel.delete')).toBe(false);
    expect(can('OWNER', 'channel.delete')).toBe(true);
  });

  it('a member may not edit somebody else, at any layer', () => {
    expect(can('MEMBER', 'message.edit.own')).toBe(true);
    expect(can('MEMBER', 'message.edit.any')).toBe(false);
  });
});

describe('a missing role is not a permissive one', () => {
  it.each([null, undefined])('%s can do nothing', (role) => {
    // The common case at the edge: an unauthenticated socket, a link to a private
    // channel, a member removed while their tab was open. A null that reads as
    // "truthy enough" grants everything.
    for (const operation of CHANNEL_OPERATIONS) {
      expect(can(role, operation)).toBe(false);
    }
  });

  it('an unknown role string is not permissive either', () => {
    // Reachable in practice: a Postgres enum gains a value and a running process
    // has the old build. `?? false` is what makes that a refusal instead of a
    // crash or a grant.
    expect(can('SUPERUSER' as never, 'message.send')).toBe(false);
  });
});

describe('the table cannot be edited by a caller', () => {
  it('operationsFor returns a copy, so a push does not grant a permission', () => {
    // The failure being prevented is process-wide and permanent: the returned
    // array is handed to a React tree, and one component treating it as its own
    // and pushing to it would grant that capability to every request the process
    // goes on to serve. `readonly` is erased at runtime and would not stop it.
    const mine = operationsFor('MEMBER');
    mine.push('channel.delete');

    expect(can('MEMBER', 'channel.delete')).toBe(false);
    // And the next caller gets the table, not the edited copy.
    expect(operationsFor('MEMBER')).not.toContain('channel.delete');
  });
});

describe('acting on one particular message', () => {
  const ANA = 'u-ana';
  const BRUNO = 'u-bruno';

  it('a member edits their own line', () => {
    expect(canActOnMessage('MEMBER', 'edit', ANA, ANA)).toBe(true);
  });

  it('and not somebody else s', () => {
    expect(canActOnMessage('MEMBER', 'edit', ANA, BRUNO)).toBe(false);
    expect(canActOnMessage('MEMBER', 'delete', ANA, BRUNO)).toBe(false);
  });

  it('a moderator reaches anybody s', () => {
    expect(canActOnMessage('ADMIN', 'delete', ANA, BRUNO)).toBe(true);
    expect(canActOnMessage('ADMIN', 'edit', ANA, BRUNO)).toBe(true);
  });

  it('nobody owns a message whose author is gone', () => {
    // `authorId` is null after the account is deleted (SetNull). Ownership cannot
    // be claimed by matching null against null, which is what a naive
    // `authorId === actorId` on two nulls would do.
    expect(canActOnMessage('MEMBER', 'delete', ANA, null)).toBe(false);
    // A moderator still reaches it, which is the right answer: a deleted
    // account's words are a moderation matter, not an ownership one.
    expect(canActOnMessage('ADMIN', 'delete', ANA, null)).toBe(true);
  });

  it('a non-member reaches nothing, even their own', () => {
    // Removed from the channel while their tab was open. The message is still
    // theirs and they are still not in the room.
    expect(canActOnMessage(null, 'edit', ANA, ANA)).toBe(false);
  });
});

describe('the matrix is data, not derived', () => {
  it('each role has a distinct capability set', () => {
    // If two roles ever hold identical sets, one of them is a synonym and the
    // product has a distinction it does not enforce.
    const sets = CHANNEL_ROLES.map((role) => operationsFor(role).sort().join('|'));
    expect(new Set(sets).size).toBe(CHANNEL_ROLES.length);
  });

  it('capability counts strictly decrease with rank', () => {
    // Not a definition of the matrix, an observation about it that would break
    // loudly if somebody granted MEMBER something ADMIN lacks by editing the
    // wrong block. The non-nesting above is about *which* capabilities, not about
    // how many.
    const counts = CHANNEL_ROLES.map((role) => operationsFor(role).length);
    for (let index = 1; index < counts.length; index += 1) {
      expect(counts[index]!).toBeLessThan(counts[index - 1]!);
    }
  });

  it('every member capability is also an admin capability', () => {
    // The parts that *are* nested, asserted so a future edit cannot quietly give
    // a member something a moderator lacks.
    for (const operation of operationsFor('MEMBER') as ChannelOperation[]) {
      expect(can('ADMIN', operation), `ADMIN lacks ${operation}`).toBe(true);
    }
  });
});
