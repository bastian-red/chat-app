/**
 * The five Redis commands `PresenceStore` actually uses, in a Map.
 *
 * Not a general Redis emulator, and deliberately not one. It implements exactly
 * `hset`, `hgetall`, `hdel`, `del` and `expire`, so a sixth command added to the
 * store is a compile error here rather than a silent no-op in a test that keeps
 * passing. A library like `ioredis-mock` would answer every command, including
 * the ones this module has no business calling.
 *
 * Expiry is **not** simulated. That is the point of the split between the lanes:
 * this file exists so the gate lane can assert on the store's *own* arithmetic
 * against an injected clock, in a millisecond, and `apps/api/test` runs the same
 * class against a real Redis for the key TTL. A fake that expired keys on a timer
 * would be a second implementation of the thing under test.
 *
 * `expires` is still recorded, because "the key was given a TTL at all" is a real
 * property: without it a channel everybody left leaves a hash behind for as long
 * as Redis runs, and nothing else in the suite would notice.
 *
 * Lives in `src/` rather than in a test file because both `index.test.ts` and any
 * later spec want it, and a helper duplicated into two specs drifts.
 */
import type { Redis } from 'ioredis';

/** What `multi()` returns: the same three commands, queued, then `exec`. */
export interface FakeMulti {
  hset: (key: string, field: string, value: string) => FakeMulti;
  expire: (key: string, seconds: number) => FakeMulti;
  exec: () => Promise<unknown>;
}

export class FakeRedis {
  /** key -> field -> value. */
  private readonly hashes = new Map<string, Map<string, string>>();
  /** key -> the last TTL in seconds it was given. Asserted, never enforced. */
  readonly expires = new Map<string, number>();
  /** Every command name, in order. Lets a test assert that a sweep happened. */
  readonly calls: string[] = [];

  private hash(key: string): Map<string, string> {
    let existing = this.hashes.get(key);
    if (!existing) {
      existing = new Map();
      this.hashes.set(key, existing);
    }
    return existing;
  }

  hset(key: string, field: string, value: string): Promise<number> {
    this.calls.push('hset');
    const created = this.hash(key).has(field) ? 0 : 1;
    this.hash(key).set(field, value);
    return Promise.resolve(created);
  }

  hgetall(key: string): Promise<Record<string, string>> {
    this.calls.push('hgetall');
    // A plain object, the way ioredis answers, and an empty one for a missing
    // key rather than null. The store iterates `Object.entries` over this, and a
    // null would throw on a channel nobody has joined yet.
    return Promise.resolve(Object.fromEntries(this.hashes.get(key) ?? new Map()));
  }

  hdel(key: string, ...fields: string[]): Promise<number> {
    this.calls.push('hdel');
    const hash = this.hashes.get(key);
    if (!hash) return Promise.resolve(0);
    let removed = 0;
    for (const field of fields) if (hash.delete(field)) removed += 1;
    return Promise.resolve(removed);
  }

  del(...keys: string[]): Promise<number> {
    this.calls.push('del');
    let removed = 0;
    for (const key of keys) {
      if (this.hashes.delete(key)) removed += 1;
      this.expires.delete(key);
    }
    return Promise.resolve(removed);
  }

  expire(key: string, seconds: number): Promise<number> {
    this.calls.push('expire');
    this.expires.set(key, seconds);
    return Promise.resolve(1);
  }

  multi(): FakeMulti {
    this.calls.push('multi');
    const queued: (() => Promise<unknown>)[] = [];
    const chain: FakeMulti = {
      hset: (key, field, value) => {
        queued.push(() => this.hset(key, field, value));
        return chain;
      },
      expire: (key, seconds) => {
        queued.push(() => this.expire(key, seconds));
        return chain;
      },
      // Sequential rather than `Promise.all`, so `calls` records the order the
      // store queued them in. A test that asserts the key got its TTL after the
      // field was written would otherwise be reading a race.
      exec: async () => {
        const results = [];
        for (const run of queued) results.push(await run());
        return results;
      },
    };
    return chain;
  }

  /** How many fields a key holds. For asserting that a sweep actually deleted. */
  fieldCount(key: string): number {
    return this.hashes.get(key)?.size ?? 0;
  }

  /** Write a raw field, to plant something the store did not write itself. */
  plant(key: string, field: string, value: string): void {
    this.hash(key).set(field, value);
  }

  /**
   * The cast the whole file exists to contain.
   *
   * `PresenceStore` takes ioredis's `Redis`, which has several hundred methods.
   * Implementing them to satisfy the type would be a day's typing for no
   * assertion, so the narrowing happens here, once, where it is documented, and
   * never at a call site where a reader would have to guess which five commands
   * were real.
   */
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

/**
 * A clock a test moves by hand.
 *
 * The store takes `now: () => number` for exactly this: TTL behaviour is
 * arithmetic on two timestamps, and a suite that proved it by sleeping for 25
 * seconds is a suite nobody runs on every commit.
 */
export class FakeClock {
  constructor(private current: number) {}

  now = (): number => this.current;

  /** Move forward. Seconds, because every TTL in this project is in seconds. */
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}
