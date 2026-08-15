/**
 * The roster arithmetic, against a fake clock and the five-command Redis double.
 *
 * What this lane can prove and what it cannot is a real split, not a compromise.
 * Everything here is the store's own decision-making: when an entry is `online`
 * rather than `away`, when it is swept, how two connections collapse into one
 * person. All of it is arithmetic on two timestamps, so a fake clock proves it in
 * a millisecond and a suite that slept for twenty-five seconds would be a suite
 * nobody runs on every commit.
 *
 * What it cannot prove is that a real Redis expires the *key* on the schedule
 * `KEY_TTL_MULTIPLIER` asks for. That is Redis's behaviour rather than this
 * module's, and `docs/SPECS.md` section 7.1.5 puts it in the integration lane.
 */
import { describe, expect, it } from 'vitest';

import { FakeClock, FakeRedis } from './fake-redis';
import {
  PresenceConfigError,
  PresenceStore,
  assertPresenceConfig,
  presenceLabel,
  presenceWord,
  type PresenceConfig,
} from './index';

/** The shipped values, from `.env.example`. Tests that need a ratio use these. */
const CONFIG: PresenceConfig = { heartbeatSeconds: 10, ttlSeconds: 25, typingTtlSeconds: 5 };

/** A fixed instant, so a failure reads the same on every machine and every run. */
const START = Date.parse('2026-08-11T10:00:00.000Z');

const ANA = { userId: 'u-ana', name: 'Ana Ruiz' };
const BRUNO = { userId: 'u-bruno', name: 'Bruno Salas' };

function build(config: PresenceConfig = CONFIG) {
  const clock = new FakeClock(START);
  const redis = new FakeRedis();
  const store = new PresenceStore(redis.asRedis(), config, clock.now);
  return { clock, redis, store };
}

describe('assertPresenceConfig', () => {
  it('accepts the shipped ratio', () => {
    expect(() => {
      assertPresenceConfig(CONFIG);
    }).not.toThrow();
  });

  it('refuses a TTL at exactly twice the heartbeat', () => {
    // The boundary is the whole reason the assertion exists. At 2x, one dropped
    // heartbeat marks somebody offline who is still reading the conversation, and
    // a roster that flickers is worse than one a few seconds stale. `20` is
    // therefore a refusal, not an edge case that happens to be allowed.
    expect(() => {
      assertPresenceConfig({ ...CONFIG, ttlSeconds: 20 });
    }).toThrow(PresenceConfigError);
  });

  it('accepts one second past twice the heartbeat', () => {
    expect(() => {
      assertPresenceConfig({ ...CONFIG, ttlSeconds: 21 });
    }).not.toThrow();
  });

  it('names both variables, because the reader has neither value in hand', () => {
    expect(() => {
      assertPresenceConfig({ ...CONFIG, ttlSeconds: 15 });
    }).toThrow(/PRESENCE_TTL_SECONDS \(15\).*PRESENCE_HEARTBEAT_SECONDS \(10\)/s);
  });

  it.each([
    ['heartbeatSeconds', { ...CONFIG, heartbeatSeconds: 0 }],
    ['ttlSeconds', { ...CONFIG, ttlSeconds: 0 }],
    ['typingTtlSeconds', { ...CONFIG, typingTtlSeconds: 0 }],
  ])('refuses a non-positive %s', (_name, config) => {
    expect(() => {
      assertPresenceConfig(config);
    }).toThrow(PresenceConfigError);
  });

  it('refuses to construct a store from a configuration that cannot work', () => {
    // In the constructor rather than at the first heartbeat: a gateway that has
    // started listening, passed its health check, and then throws on somebody's
    // first `presence.ping` is far harder to diagnose than one that refused to
    // boot.
    const redis = new FakeRedis();
    expect(() => new PresenceStore(redis.asRedis(), { ...CONFIG, ttlSeconds: 20 })).toThrow(
      PresenceConfigError,
    );
  });
});

describe('roster', () => {
  it('is empty for a channel nobody has joined', async () => {
    const { store } = build();
    await expect(store.roster('c1')).resolves.toEqual([]);
  });

  it('reports a fresh heartbeat as online, with initials the chip can render', async () => {
    const { store } = build();
    await store.touch('c1', 'socket-1', ANA);

    const roster = await store.roster('c1');

    expect(roster).toHaveLength(1);
    expect(roster[0]).toMatchObject({
      userId: 'u-ana',
      name: 'Ana Ruiz',
      initials: 'AR',
      state: 'online',
      connections: 1,
    });
    // An ISO string, not a Date. Everything on this roster crosses a socket, and
    // `JSON.stringify` turns a Date into a string anyway; producing one here
    // means the type says what the client will actually receive.
    expect(roster[0]?.lastSeenAt).toBe('2026-08-11T10:00:00.000Z');
  });

  it('gives the key a TTL, so an abandoned channel does not leak a hash', async () => {
    const { redis, store } = build();
    await store.touch('c1', 'socket-1', ANA);

    // Four times the field TTL: the key only has to outlive its last live field,
    // and it is refreshed on every write, so an active channel never expires
    // under its own users.
    expect(redis.expires.get('presence:c1')).toBe(100);
  });

  describe('two tabs is one person', () => {
    it('collapses two connections into one entry that counts them', async () => {
      const { store } = build();
      await store.touch('c1', 'socket-1', ANA);
      await store.touch('c1', 'socket-2', ANA);

      const roster = await store.roster('c1');

      expect(roster).toHaveLength(1);
      expect(roster[0]?.connections).toBe(2);
    });

    it('keeps the person online when one tab closes', async () => {
      // The requirement this whole data structure exists for. Keyed by user
      // rather than by connection, this `leave` would delete Ana's only entry and
      // evict somebody who is still reading the conversation in the other tab.
      const { store } = build();
      await store.touch('c1', 'socket-1', ANA);
      await store.touch('c1', 'socket-2', ANA);

      await store.leave('c1', 'socket-2');

      const roster = await store.roster('c1');
      expect(roster).toHaveLength(1);
      expect(roster[0]).toMatchObject({ userId: 'u-ana', state: 'online', connections: 1 });
    });

    it('removes the person once the last tab closes', async () => {
      const { store } = build();
      await store.touch('c1', 'socket-1', ANA);

      await store.leave('c1', 'socket-1');

      await expect(store.roster('c1')).resolves.toEqual([]);
    });
  });

  describe('state from the age of the entry', () => {
    it('stays online while the client is heartbeating normally', async () => {
      // A 10s heartbeat against a 25s TTL: a healthy client is never older than
      // one beat, which is well inside half the TTL.
      const { clock, store } = build();
      await store.touch('c1', 'socket-1', ANA);

      clock.advanceSeconds(10);

      const roster = await store.roster('c1');
      expect(roster[0]?.state).toBe('online');
    });

    it('reads away once past half the TTL, which is one missed beat', async () => {
      const { clock, store } = build();
      await store.touch('c1', 'socket-1', ANA);

      // 12.5s is half of 25. A client that missed one beat crosses it and reads
      // `away` for the couple of seconds until the next one lands, which is the
      // honest answer: a missed heartbeat genuinely means "I am not sure".
      clock.advanceSeconds(13);

      const roster = await store.roster('c1');
      expect(roster[0]?.state).toBe('away');
    });

    it('treats a typist as online however stale the entry is', async () => {
      // Typing is the strongest evidence of presence there is. Demoting somebody
      // to `away` while the indicator beside their name says they are mid-sentence
      // is a roster that contradicts the line above it.
      const { clock, store } = build();
      await store.touch('c1', 'socket-1', ANA, 'typing');

      clock.advanceSeconds(20);

      const roster = await store.roster('c1');
      expect(roster[0]?.state).toBe('online');
    });

    it('lets the strongest state win when one tab is stale and one is live', async () => {
      const { clock, store } = build();
      await store.touch('c1', 'stale-tab', ANA);
      clock.advanceSeconds(20);
      await store.touch('c1', 'live-tab', ANA);

      const roster = await store.roster('c1');

      // Taking the most recent write instead would be the same answer here, but
      // taking the *weakest* or the first would make the chip flicker at the
      // heartbeat interval for as long as both tabs are open. The roster answers
      // "can I expect a reply", and the live tab settles that.
      expect(roster[0]).toMatchObject({ state: 'online', connections: 2 });
      // The newer heartbeat is what `lastSeenAt` reports, not the one that
      // happened to be written first.
      expect(roster[0]?.lastSeenAt).toBe('2026-08-11T10:00:20.000Z');
    });
  });

  describe('the sweep', () => {
    it('drops an entry that has passed its TTL', async () => {
      const { clock, store } = build();
      await store.touch('c1', 'socket-1', ANA);

      clock.advanceSeconds(25);

      await expect(store.roster('c1')).resolves.toEqual([]);
    });

    it('deletes the field rather than only filtering it out of the answer', async () => {
      // Filtering alone would leave the hash growing forever on a busy channel:
      // every reconnect writes a new socket id, and nothing would ever remove the
      // old one. Redis expires keys and not hash fields (HEXPIRE is 7.4+, and
      // compose pins redis:7-alpine), so the read path is where this has to
      // happen.
      const { clock, redis, store } = build();
      await store.touch('c1', 'socket-1', ANA);
      expect(redis.fieldCount('presence:c1')).toBe(1);

      clock.advanceSeconds(25);
      await store.roster('c1');

      expect(redis.fieldCount('presence:c1')).toBe(0);
    });

    it('does not issue a delete when nothing has expired', async () => {
      const { redis, store } = build();
      await store.touch('c1', 'socket-1', ANA);
      redis.calls.length = 0;

      await store.roster('c1');

      // One HGETALL and no HDEL. A sweep that fired on every read would double
      // the round trips on the hottest path in the gateway.
      expect(redis.calls).toEqual(['hgetall']);
    });

    it('drops a field it cannot parse instead of leaving a ghost forever', async () => {
      // Written by an older shape of this code, or corrupted. Keeping it would
      // leave somebody in the channel until Redis restarted, and it is
      // indistinguishable from expired for every purpose this module has.
      const { redis, store } = build();
      redis.plant('presence:c1', 'socket-junk', 'not json');
      await store.touch('c1', 'socket-1', ANA);

      const roster = await store.roster('c1');

      expect(roster).toHaveLength(1);
      expect(redis.fieldCount('presence:c1')).toBe(1);
    });

    it('drops a field whose shape is wrong even though it is valid JSON', async () => {
      const { redis, store } = build();
      redis.plant('presence:c1', 'socket-old', JSON.stringify({ user: 'u-ana', ts: START }));

      await expect(store.roster('c1')).resolves.toEqual([]);
    });
  });

  it('orders by name rather than by arrival', async () => {
    // A roster that reorders itself whenever a heartbeat lands is a column of
    // names that shuffle while you are reading them, which moves the one you were
    // about to click.
    const { store } = build();
    await store.touch('c1', 'socket-b', BRUNO);
    await store.touch('c1', 'socket-a', ANA);

    const roster = await store.roster('c1');

    expect(roster.map((member) => member.name)).toEqual(['Ana Ruiz', 'Bruno Salas']);
  });

  it('keeps channels separate', async () => {
    const { store } = build();
    await store.touch('c1', 'socket-1', ANA);
    await store.touch('c2', 'socket-2', BRUNO);

    await expect(store.roster('c1')).resolves.toHaveLength(1);
    expect((await store.roster('c2'))[0]?.userId).toBe('u-bruno');
  });
});

describe('typing', () => {
  it('is empty for a channel where nobody is typing', async () => {
    const { store } = build();
    await expect(store.typing('c1')).resolves.toEqual([]);
  });

  it('reports somebody who started', async () => {
    const { store } = build();
    await store.startTyping('c1', ANA);

    await expect(store.typing('c1')).resolves.toEqual([{ userId: 'u-ana', name: 'Ana Ruiz' }]);
  });

  it('announces one person once however many tabs they have', async () => {
    // Keyed by user, which is the opposite of the roster and is deliberate. "Is
    // Ana typing?" has one answer per person however many tabs she has open, and
    // a per-connection typing set would announce her twice in the same sentence.
    const { store } = build();
    await store.startTyping('c1', ANA);
    await store.startTyping('c1', ANA);

    await expect(store.typing('c1')).resolves.toHaveLength(1);
  });

  it('clears immediately on stop rather than waiting out the TTL', async () => {
    const { store } = build();
    await store.startTyping('c1', ANA);

    await store.stopTyping('c1', 'u-ana');

    await expect(store.typing('c1')).resolves.toEqual([]);
  });

  it('expires at TYPING_TTL_SECONDS without a stop ever arriving', async () => {
    // The tab that closed mid-word never sends `typing.stop`. Five seconds, short
    // on purpose: an indicator that outlives the typing is a lie about who is in
    // the conversation.
    const { clock, store } = build();
    await store.startTyping('c1', ANA);

    clock.advanceSeconds(5);

    await expect(store.typing('c1')).resolves.toEqual([]);
  });

  it('survives right up to the TTL', async () => {
    const { clock, store } = build();
    await store.startTyping('c1', ANA);

    clock.advanceSeconds(4);

    await expect(store.typing('c1')).resolves.toHaveLength(1);
  });

  it('is read as the complete set, ordered by name', async () => {
    // A join/leave delta would require every client to hold a set that drifts:
    // one missed "stopped" leaves somebody typing forever and nothing in the
    // protocol would ever correct it. Sending the whole set makes every broadcast
    // a complete correction.
    const { store } = build();
    await store.startTyping('c1', BRUNO);
    await store.startTyping('c1', ANA);

    const typing = await store.typing('c1');

    expect(typing.map((member) => member.name)).toEqual(['Ana Ruiz', 'Bruno Salas']);
  });

  it('sweeps the expired field, not just the answer', async () => {
    const { clock, redis, store } = build();
    await store.startTyping('c1', ANA);

    clock.advanceSeconds(5);
    await store.typing('c1');

    expect(redis.fieldCount('typing:c1')).toBe(0);
  });

  it('gives its key a TTL too', async () => {
    const { redis, store } = build();
    await store.startTyping('c1', ANA);

    expect(redis.expires.get('typing:c1')).toBe(20);
  });
});

describe('clear', () => {
  it('forgets both keys, so nobody is typing in a channel with nobody in it', async () => {
    const { redis, store } = build();
    await store.touch('c1', 'socket-1', ANA);
    await store.startTyping('c1', ANA);

    await store.clear('c1');

    expect(redis.fieldCount('presence:c1')).toBe(0);
    expect(redis.fieldCount('typing:c1')).toBe(0);
  });
});

describe('the words', () => {
  it('re-exports them rather than redefining them', () => {
    // The assertion is that these are the same functions `@chat/shared` exports,
    // which is what stops a screen-reader user hearing "Ana Ruiz, online" while a
    // sighted colleague reads "Ana (available)". They live in shared because the
    // browser renders them and this package imports ioredis.
    expect(presenceWord('online')).toBe('Online');
    expect(presenceLabel({ userId: 'u-ana', name: 'Ana Ruiz', state: 'away' })).toBe(
      'Ana Ruiz, away',
    );
  });
});
