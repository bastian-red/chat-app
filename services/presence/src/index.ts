/**
 * Who is in a channel right now, and who is typing in it.
 *
 * Both are the same kind of fact and neither belongs in Postgres: they are
 * worthless a minute after they are written, every heartbeat rewrites them, and
 * several gateway replicas have to agree on them. Storing presence in Postgres
 * would mean one write per client per ten seconds, forever, to a table nobody
 * would ever read historically.
 *
 * ---------------------------------------------------------------------------
 * The data structure, and why the roster is not a set of user ids
 *
 * One Redis **hash** per channel, `presence:<channelId>`, with one field per
 * *connection*:
 *
 *   HSET presence:c1 <socketId> '{"userId":...,"activity":"viewing","at":...}'
 *
 * Keyed by connection, not by user, because a person with two tabs open is one
 * person with two connections. Keyed by user, closing one tab would delete the
 * entry and evict somebody who is still reading the conversation in the other
 * one, and the roster would say they left a channel they never left. `roster()`
 * collapses connections back to people and reports the count.
 *
 * `docs/ROADMAP.md` section 2 describes the write as `SET presence:<id>:<userId>`
 * with an `EX`. That shape cannot hold the bullet three lines below it in the
 * same list ("two tabs is one person online, and closing one must not mark them
 * offline"), because a key per user has nothing to count. The hash is what the
 * connection-counting requirement forces, and `roster()` is one `HGETALL` rather
 * than the `SCAN` a key-per-connection scheme would need.
 *
 * ---------------------------------------------------------------------------
 * Expiry: a per-field timestamp, not a per-field TTL
 *
 * Redis expires keys, not hash fields. `HEXPIRE` exists only from Redis 7.4 and
 * `infra/docker-compose.yml` pins `redis:7-alpine`, which is 7.2. So each field
 * carries the instant it was last refreshed and every read filters out anything
 * older than the TTL.
 *
 * The whole key still gets a TTL, refreshed on every write and generous relative
 * to the field TTL. That is the garbage collector: a channel everybody left
 * leaves a hash holding a few dead fields, and without a key TTL those hashes
 * accumulate for as long as Redis runs.
 *
 * ---------------------------------------------------------------------------
 * Why the sweep is on the read path
 *
 * Stale fields are deleted by `roster()` and `typing()` rather than by a timer.
 * A timer would need leader election across gateway replicas to stop N copies of
 * the same sweep running, and a channel nobody is reading does not need an
 * accurate roster -- there is nobody to be wrong in front of.
 *
 * ---------------------------------------------------------------------------
 * What this module deliberately does not own
 *
 * The **words**. `presenceWord` and `presenceLabel` are re-exported from
 * `@chat/shared` at the bottom of this file and are never redefined here,
 * because the browser renders them and this package imports `ioredis`: a web
 * bundle reaching for `presenceLabel` would pull a Redis client into it. One
 * implementation, or a screen-reader user hears "Ana Ruiz, online" while a
 * sighted colleague reads "Ana (available)", which is two descriptions of one
 * fact.
 *
 * And the **client**. The Redis connection arrives through the constructor. A
 * service that constructs its own cannot be tested without one, and a test that
 * needs a container to check TTL arithmetic is a test that gets skipped.
 */
import type { Redis } from 'ioredis';

import { initialsOf, type PresenceActivity, type PresenceState } from '@chat/shared';

export interface PresenceConfig {
  /** How often a client refreshes its entry. From PRESENCE_HEARTBEAT_SECONDS. */
  heartbeatSeconds: number;
  /**
   * How long an entry survives without a refresh. From PRESENCE_TTL_SECONDS.
   *
   * Deliberately more than twice the heartbeat: at exactly 2x, one dropped
   * packet marks somebody offline who is still reading, and a roster that
   * flickers is worse than one that is a few seconds stale.
   */
  ttlSeconds: number;
  /**
   * How long a typing entry survives without a refresh. From
   * TYPING_TTL_SECONDS.
   *
   * Much shorter than the presence TTL, and allowed to be shorter than the
   * heartbeat, because it is refreshed by keystrokes rather than by a timer. A
   * typing indicator that outlives the typing is a lie about who is in the
   * conversation, and the cost of it expiring early is that the next keystroke
   * puts it back.
   */
  typingTtlSeconds: number;
}

export interface PresenceIdentity {
  userId: string;
  name: string;
}

/** One person in a channel, after connections have been collapsed. */
export interface RosterMember {
  userId: string;
  name: string;
  /** Computed here so the roster, the member list and the chip agree. */
  initials: string;
  state: PresenceState;
  /** How many sockets this person has open. Two tabs is one person. */
  connections: number;
  lastSeenAt: string;
}

/** One person typing in a channel. The wire shape of `typing.changed`. */
export interface TypingMember {
  userId: string;
  name: string;
}

interface StoredPresence {
  userId: string;
  name: string;
  activity: PresenceActivity;
  /** Epoch milliseconds of the last heartbeat. */
  at: number;
}

interface StoredTyping {
  name: string;
  at: number;
}

export class PresenceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresenceConfigError';
  }
}

/**
 * Refuse a configuration that cannot work, before anything depends on it.
 *
 * Exported because `apps/realtime/src/boot.ts` calls it at boot as well, and the
 * constructor below calls it too. The two are not redundant: the constructor
 * runs when the gateway first touches presence, which is after it has started
 * listening and passed its own health check, and a process that accepts
 * connections and then throws on the first heartbeat is far harder to diagnose
 * than one that refused to start.
 */
export function assertPresenceConfig(config: PresenceConfig): void {
  if (config.heartbeatSeconds <= 0 || config.ttlSeconds <= 0 || config.typingTtlSeconds <= 0) {
    throw new PresenceConfigError(
      'PRESENCE_HEARTBEAT_SECONDS, PRESENCE_TTL_SECONDS and TYPING_TTL_SECONDS must all be positive.',
    );
  }
  if (config.ttlSeconds <= config.heartbeatSeconds * 2) {
    throw new PresenceConfigError(
      `PRESENCE_TTL_SECONDS (${String(config.ttlSeconds)}) must be more than twice ` +
        `PRESENCE_HEARTBEAT_SECONDS (${String(config.heartbeatSeconds)}). At or below 2x, one ` +
        'dropped heartbeat marks somebody offline who is still reading the conversation.',
    );
  }
}

/**
 * The fraction of its TTL an entry may spend before it is reported as `away`.
 *
 * Half. With the shipped values (10s heartbeat, 25s TTL) a client that is
 * heartbeating normally is never older than 10s, so it reads `online`; a client
 * that has missed one beat crosses 12.5s and reads `away` for the couple of
 * seconds until the next one lands. That is the honest answer: a missed
 * heartbeat is genuinely "I am not sure", which is what `away` means, and it is
 * two full beats rather than one before the entry disappears entirely.
 *
 * Written as a named constant rather than inlined because the value is the whole
 * difference between a roster that degrades and one that flickers between
 * present and gone.
 */
const AWAY_AT_FRACTION_OF_TTL = 0.5;

/**
 * How much longer than a field the key itself lives.
 *
 * The key only has to outlive its last live field, and it is refreshed on every
 * write, so an active channel's hash never expires under its own users. Four
 * times leaves room for a client whose heartbeats are being throttled by a
 * backgrounded tab.
 */
const KEY_TTL_MULTIPLIER = 4;

const rosterKey = (channelId: string): string => `presence:${channelId}`;
const typingKey = (channelId: string): string => `typing:${channelId}`;

export class PresenceStore {
  private readonly redis: Redis;
  private readonly config: PresenceConfig;
  /** Injected, never `Date.now()` inline, so the TTL is testable without waiting. */
  private readonly now: () => number;

  constructor(redis: Redis, config: PresenceConfig, now: () => number = Date.now) {
    // In the constructor rather than at the first call: a store built from a
    // configuration that cannot work must not exist, or the failure surfaces on
    // somebody's first heartbeat instead of at the point of the mistake.
    assertPresenceConfig(config);
    this.redis = redis;
    this.config = config;
    this.now = now;
  }

  /**
   * Record or refresh one connection's presence in a channel.
   *
   * The same call for "joined" and "still here". A heartbeat is an upsert, so a
   * client that reconnects onto a different replica needs no special handling
   * and a join whose write was lost is repaired by the next beat rather than
   * leaving somebody invisible for the rest of their session.
   */
  async touch(
    channelId: string,
    connectionId: string,
    identity: PresenceIdentity,
    activity: PresenceActivity = 'viewing',
  ): Promise<void> {
    const entry: StoredPresence = {
      userId: identity.userId,
      name: identity.name,
      activity,
      at: this.now(),
    };
    const key = rosterKey(channelId);
    // Pipelined: the field write and the key TTL are one round trip. They do not
    // need to be atomic with each other, because a key that briefly lacks a TTL
    // is harmless and the next heartbeat sets it again.
    await this.redis
      .multi()
      .hset(key, connectionId, JSON.stringify(entry))
      .expire(key, this.config.ttlSeconds * KEY_TTL_MULTIPLIER)
      .exec();
  }

  /** Remove one connection. The common case is a socket disconnecting. */
  async leave(channelId: string, connectionId: string): Promise<void> {
    await this.redis.hdel(rosterKey(channelId), connectionId);
  }

  /**
   * Who is in the channel, collapsed to people, sweeping what has expired.
   *
   * Always the complete set, never a delta, for the same reason `typing.changed`
   * is: a client holding an incrementally-patched roster has state that can
   * drift and never repairs itself, and one missed "left" leaves a ghost in the
   * sidebar until the tab is reloaded.
   */
  async roster(channelId: string): Promise<RosterMember[]> {
    const key = rosterKey(channelId);
    const raw = await this.redis.hgetall(key);
    const now = this.now();

    const expired: string[] = [];
    const live: StoredPresence[] = [];

    for (const [connectionId, value] of Object.entries(raw)) {
      const entry = parse<StoredPresence>(value);
      if (!entry || typeof entry.at !== 'number' || typeof entry.userId !== 'string') {
        // Unparseable, or written by an older shape of this code. Keeping it
        // would leave a ghost in the channel forever, and it is indistinguishable
        // from expired for every purpose this module has.
        expired.push(connectionId);
        continue;
      }
      if (now - entry.at >= this.config.ttlSeconds * 1000) {
        expired.push(connectionId);
        continue;
      }
      live.push(entry);
    }

    if (expired.length > 0) {
      // Awaited rather than fire-and-forget: a rejected promise nobody holds is
      // an unhandled rejection, and this runs on the gateway, where that takes
      // every socket on the replica down with it. If it fails, the next read
      // sweeps again.
      await this.redis.hdel(key, ...expired);
    }

    return collapse(live, now, this.config);
  }

  /**
   * Mark somebody as typing in a channel.
   *
   * Keyed by **user**, not by connection, which is the opposite of the roster
   * and is deliberate. "Is Ana typing?" has one answer per person however many
   * tabs she has open, and a per-connection typing set would announce her twice.
   * The cost is that a `typing.stop` from one tab clears her while another tab
   * is still mid-word; that self-heals on her next keystroke, within
   * TYPING_TTL_SECONDS, which is why the TTL is seconds rather than minutes.
   */
  async startTyping(channelId: string, identity: PresenceIdentity): Promise<void> {
    const entry: StoredTyping = { name: identity.name, at: this.now() };
    const key = typingKey(channelId);
    await this.redis
      .multi()
      .hset(key, identity.userId, JSON.stringify(entry))
      .expire(key, this.config.typingTtlSeconds * KEY_TTL_MULTIPLIER)
      .exec();
  }

  /** Stop, explicitly. The TTL would do it anyway; this makes it immediate. */
  async stopTyping(channelId: string, userId: string): Promise<void> {
    await this.redis.hdel(typingKey(channelId), userId);
  }

  /**
   * Everybody typing in a channel, as the complete set.
   *
   * A delta would require each client to hold a set that drifts: one missed
   * "stopped" leaves somebody typing forever, and there is nothing in the
   * protocol that would ever correct it. The set is bounded by the membership
   * and by a five-second TTL, so sending all of it makes every broadcast a
   * complete correction.
   */
  async typing(channelId: string): Promise<TypingMember[]> {
    const key = typingKey(channelId);
    const raw = await this.redis.hgetall(key);
    const now = this.now();

    const expired: string[] = [];
    const live: TypingMember[] = [];

    for (const [userId, value] of Object.entries(raw)) {
      const entry = parse<StoredTyping>(value);
      if (!entry || typeof entry.at !== 'number' || typeof entry.name !== 'string') {
        expired.push(userId);
        continue;
      }
      if (now - entry.at >= this.config.typingTtlSeconds * 1000) {
        expired.push(userId);
        continue;
      }
      live.push({ userId, name: entry.name });
    }

    if (expired.length > 0) await this.redis.hdel(key, ...expired);

    // By name, not by when they started. A list that reorders itself as people
    // type is a sentence that rewrites itself under the reader.
    return live.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Forget a channel entirely.
   *
   * Both keys, because forgetting the roster and leaving the typing set behind
   * would announce somebody typing in a channel with nobody in it. Used by the
   * integration lane between cases.
   */
  async clear(channelId: string): Promise<void> {
    await this.redis.del(rosterKey(channelId), typingKey(channelId));
  }
}

/** JSON that may not be JSON. Returns null rather than throwing into a sweep. */
function parse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * One connection's presence state, from how long ago it last spoke.
 *
 * Three rules, each of which is a decision rather than a detail:
 *
 * - **A typist is online.** Typing is the strongest evidence of presence there
 *   is, and demoting somebody to `away` while the typing indicator beside their
 *   name says they are mid-sentence is a roster that contradicts the line above
 *   it.
 * - **Past half the TTL is `away`.** See `AWAY_AT_FRACTION_OF_TTL`.
 * - **Absent is `offline`**, and absence is decided by the caller's sweep rather
 *   than here, so there is one definition of expiry rather than two.
 */
function stateOf(ageMs: number, activity: PresenceActivity, config: PresenceConfig): PresenceState {
  if (activity === 'typing') return 'online';
  return ageMs >= config.ttlSeconds * 1000 * AWAY_AT_FRACTION_OF_TTL ? 'away' : 'online';
}

/**
 * Connections to people.
 *
 * Two rules that are also design decisions:
 *
 * - **The strongest state wins.** Somebody with a stale tab and a live one is
 *   `online`. Taking the most recent write instead would make the chip flicker
 *   at the heartbeat interval for as long as both tabs are open, and the roster
 *   answers "can I expect a reply", which the live tab settles.
 * - **Order is by name, not by arrival.** A roster that reorders itself whenever
 *   a heartbeat lands is a column of names that shuffle while you are reading
 *   them, which moves the one you were about to click.
 */
function collapse(
  entries: readonly StoredPresence[],
  now: number,
  config: PresenceConfig,
): RosterMember[] {
  const rank: Record<PresenceState, number> = { offline: 0, away: 1, online: 2 };
  const byUser = new Map<string, RosterMember>();

  for (const entry of entries) {
    const state = stateOf(now - entry.at, entry.activity, config);
    const existing = byUser.get(entry.userId);

    if (!existing) {
      byUser.set(entry.userId, {
        userId: entry.userId,
        name: entry.name,
        initials: initialsOf(entry.name),
        state,
        connections: 1,
        lastSeenAt: new Date(entry.at).toISOString(),
      });
      continue;
    }

    byUser.set(entry.userId, {
      ...existing,
      connections: existing.connections + 1,
      state: rank[state] > rank[existing.state] ? state : existing.state,
      lastSeenAt:
        entry.at > Date.parse(existing.lastSeenAt)
          ? new Date(entry.at).toISOString()
          : existing.lastSeenAt,
    });
  }

  return [...byUser.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * The words beside a roster entry.
 *
 * Re-exported, never redefined. They live in `@chat/shared` because the browser
 * renders them and this package imports `ioredis`; the design rule they satisfy
 * is that presence is never colour alone, since light-mode `online` and
 * `offline` differ by a contrast ratio of 1.00 and are the same pixel to a
 * reader on a greyscale display.
 */
export {
  presenceGlyph,
  presenceLabel,
  presenceSummary,
  presenceWord,
  typingSummary,
} from '@chat/shared';
