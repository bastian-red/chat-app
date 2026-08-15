import { describe, expect, it } from 'vitest';

import { handleOf, mentionsIn, type Mentionable } from './mentions';

const ANA: Mentionable = { userId: 'u-ana', name: 'Ana Ruiz' };
const BRUNO: Mentionable = { userId: 'u-bruno', name: 'Bruno Salas' };
const JOSE: Mentionable = { userId: 'u-jose', name: 'José Peña' };
const MEMBERS = [ANA, BRUNO, JOSE];

describe('the handle a name is mentioned by', () => {
  it('is the name, lowercased, with the punctuation gone', () => {
    expect(handleOf('Ana Ruiz')).toBe('anaruiz');
    expect(handleOf("O'Brien-Smith")).toBe('obriensmith');
  });

  it('folds accents, because a reader without them is still trying', () => {
    // Somebody typing `@jose` on a keyboard with no accents is mentioning José.
    // Telling them otherwise is a bug they cannot diagnose: the message renders,
    // the notification does not arrive, and nothing says why.
    expect(handleOf('José Peña')).toBe('josepena');
  });

  it('is empty for a name with nothing alphanumeric in it', () => {
    // Reachable: a display name of emoji. An empty handle must not become a
    // handle that everything matches.
    expect(handleOf('🙂')).toBe('');
  });
});

describe('finding mentions in a body', () => {
  it('resolves a handle to a user id', () => {
    expect(mentionsIn('morning @anaruiz', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });

  it('is case-insensitive', () => {
    expect(mentionsIn('@AnaRuiz can you look?', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });

  it('finds several, once each', () => {
    const found = mentionsIn('@anaruiz @brunosalas @anaruiz', MEMBERS, 'u-carla');
    expect(found.sort()).toEqual([ANA.userId, BRUNO.userId].sort());
  });

  it('does not mention the author of the message', () => {
    // A message that names its own sender should not notify them. It happens
    // constantly in practice -- quoting a previous line, correcting oneself.
    expect(mentionsIn('as @anaruiz said', MEMBERS, ANA.userId)).toEqual([]);
  });
});

describe('what is deliberately not a mention', () => {
  it('an email address does not notify whoever matches its domain', () => {
    // `ana@chat.local` contains `@chat`. In a product where people paste
    // addresses into conversations constantly, matching there would notify a
    // person named "Chat" every time somebody shared a contact.
    const members = [...MEMBERS, { userId: 'u-chat', name: 'Chat' }];
    expect(mentionsIn('write to ana@chat.local', members, BRUNO.userId)).toEqual([]);
  });

  it('a doubled at-sign is not a mention', () => {
    expect(mentionsIn('@@anaruiz', MEMBERS, BRUNO.userId)).toEqual([]);
  });

  it('somebody who is not in this channel is text', () => {
    // The security property, not a nicety. Resolving against every user in the
    // database would let anybody notify anybody by typing their handle into a
    // private channel they share with nobody.
    expect(mentionsIn('@carladiaz look at this', MEMBERS, ANA.userId)).toEqual([]);
  });

  it('@everyone is not treated as a mention of the channel', () => {
    // It is a moderation feature with its own permission and its own rate limit.
    // Quietly treating it as a mention of everybody would be a notification storm
    // nobody asked for.
    expect(mentionsIn('@everyone ship it', MEMBERS, ANA.userId)).toEqual([]);
  });
});

describe('a mention at a boundary', () => {
  it('at the very start of the body', () => {
    expect(mentionsIn('@anaruiz hello', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });

  it('at the very end', () => {
    expect(mentionsIn('hello @anaruiz', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });

  it('after punctuation', () => {
    expect(mentionsIn('(cc: @anaruiz)', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });

  it('on its own line', () => {
    expect(mentionsIn('done\n@anaruiz', MEMBERS, BRUNO.userId)).toEqual([ANA.userId]);
  });
});

describe('two names that collapse to one handle', () => {
  it('resolves to the first, deterministically', () => {
    // "Ana Ruiz" and "Ana-Ruiz" both produce `anaruiz`. Notifying both means one
    // of them gets a mention for a message that was not about them; notifying by
    // iteration order means it varies per request. First-writer-wins is at least
    // stable, and the ambiguity is a product problem rather than a code one.
    const twins = [ANA, { userId: 'u-other', name: 'Ana-Ruiz' }];
    expect(mentionsIn('@anaruiz', twins, BRUNO.userId)).toEqual([ANA.userId]);
    expect(mentionsIn('@anaruiz', [...twins].reverse(), BRUNO.userId)).toEqual(['u-other']);
  });

  it('a member whose name has no handle never matches', () => {
    // An empty handle must not become a wildcard. Without the `handle !== ''`
    // guard, `byHandle.get('')` would be reachable and a stray `@` could resolve
    // to whoever is named with emoji.
    const members = [{ userId: 'u-emoji', name: '🙂' }, ANA];
    expect(mentionsIn('@ hello', members, BRUNO.userId)).toEqual([]);
  });
});
