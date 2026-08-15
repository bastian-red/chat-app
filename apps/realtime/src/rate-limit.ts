/**
 * A per-socket event budget, in this process's memory.
 *
 * **In memory and not in Redis, deliberately.** A socket lives on exactly one
 * replica for its whole life: it connects to one gateway, every frame it sends
 * arrives at that gateway, and when it reconnects it gets a fresh budget because
 * it is a new socket. There is nothing to share, so a Redis round trip per event
 * would add a network hop to the hottest path in the process to synchronise a
 * counter only one process ever reads.
 *
 * That is the opposite of the API's throttler, which keys on client address and
 * genuinely does need Redis, because a client's requests land on whichever process
 * the load balancer picked.
 *
 * ---------------------------------------------------------------------------
 * A sliding window, not a fixed one
 *
 * A fixed window resets on a boundary, so a client can spend the whole budget at
 * 0:59 and the whole budget again at 1:01 and send twice the limit in two seconds.
 * With typing pings that is the normal case rather than an attack. This keeps the
 * timestamps and expires them individually.
 *
 * ---------------------------------------------------------------------------
 * A refusal is not an event
 *
 * `record` is called only when an event is **allowed**. This is the one thing here
 * that is easy to get backwards and it matters: if a refused event were recorded,
 * a client in a loop would keep pushing its own timestamps forward and would stay
 * over the limit for as long as it kept trying, which turns a momentary burst into
 * a permanent lockout. Refusing without recording means the window drains on
 * schedule and the client recovers the moment it slows down.
 *
 * The gateway answers `RATE_LIMITED` rather than disconnecting, for the same
 * reason: a disconnect costs the client its whole channel state and triggers a
 * reconnect plus a catch-up, which is more load than the frames that were refused.
 */

/** The window every limit in this file is expressed over. */
const WINDOW_MS = 60_000;

export class SlidingWindowLimiter {
  /**
   * When each allowed event happened, oldest first.
   *
   * An array rather than a ring buffer: the limit is 240 and the array is pruned
   * on every call, so it never holds more than that. A ring buffer would be the
   * same memory with an index nobody can read at 2am.
   */
  private readonly hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {
    if (limit < 1) throw new RangeError('SOCKET_EVENT_RATE_LIMIT must be at least 1');
  }

  /** Whether one more event fits. Does not consume the budget; `record` does. */
  allows(): boolean {
    this.prune();
    return this.hits.length < this.limit;
  }

  /** Spend one. Called only after `allows()` returned true. See the header. */
  record(): void {
    this.hits.push(this.now());
  }

  /**
   * How long until the next event would be allowed, in milliseconds.
   *
   * Handed to the client in the `RATE_LIMITED` message so a backoff is a number
   * rather than a guess. Zero when there is budget now.
   */
  retryAfterMs(): number {
    this.prune();
    if (this.hits.length < this.limit) return 0;
    // The oldest hit is the one whose expiry frees a slot. `hits` is in insertion
    // order, which is time order, because `now` only moves forward.
    const oldest = this.hits[0] ?? this.now();
    return Math.max(0, oldest + WINDOW_MS - this.now());
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS;
    // From the front, and stopping at the first live one. The array is sorted, so
    // a filter over the whole thing would be the same answer at 240 times the
    // cost on the busiest path in the process.
    let drop = 0;
    while (drop < this.hits.length && (this.hits[drop] ?? 0) <= cutoff) drop += 1;
    if (drop > 0) this.hits.splice(0, drop);
  }
}

/**
 * One limiter per socket, dropped when the socket goes.
 *
 * A Map keyed by socket id rather than a property on the socket object, so the
 * limiter is testable without a socket and so the cleanup is one call in one
 * place. A leak here is unbounded: a gateway that never forgot a disconnected
 * socket would hold a timestamp array per connection it had ever served.
 */
export class SocketLimiters {
  private readonly limiters = new Map<string, SlidingWindowLimiter>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = Date.now,
  ) {}

  for(socketId: string): SlidingWindowLimiter {
    let limiter = this.limiters.get(socketId);
    if (!limiter) {
      limiter = new SlidingWindowLimiter(this.limit, this.now);
      this.limiters.set(socketId, limiter);
    }
    return limiter;
  }

  forget(socketId: string): void {
    this.limiters.delete(socketId);
  }

  /** How many sockets are being tracked. Asserted by the leak test. */
  get size(): number {
    return this.limiters.size;
  }
}
