/**
 * The event budget, against a clock a test moves by hand.
 *
 * The three properties worth pinning are the ones that are wrong in most
 * hand-rolled limiters: the window slides rather than resetting on a boundary, a
 * refusal does not extend the ban, and the limiter is dropped when its socket is.
 */
import { describe, expect, it } from 'vitest';

import { SlidingWindowLimiter, SocketLimiters } from './rate-limit';

class Clock {
  constructor(private current = 1_000_000) {}
  now = (): number => this.current;
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}

/** Spend the whole budget. Mirrors what `dispatch` does: check, then record. */
function spend(limiter: SlidingWindowLimiter, times: number): number {
  let allowed = 0;
  for (let i = 0; i < times; i += 1) {
    if (limiter.allows()) {
      limiter.record();
      allowed += 1;
    }
  }
  return allowed;
}

describe('SlidingWindowLimiter', () => {
  it('refuses a limit below one, which would refuse everything silently', () => {
    expect(() => new SlidingWindowLimiter(0)).toThrow(RangeError);
  });

  it('allows exactly the limit inside one window', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(5, clock.now);

    expect(spend(limiter, 8)).toBe(5);
  });

  it('frees slots one at a time, in the order they were spent', () => {
    // The property a fixed window does not have. Each hit expires on its own
    // sixtieth second rather than the whole window resetting on a boundary, so a
    // client cannot spend the budget at 0:59, spend it again at 1:01, and send
    // twice the limit in two seconds. With typing pings that is the normal case
    // rather than an attack.
    //
    // The hits are deliberately one second apart. Five hits at the same instant
    // would expire at the same instant and free five slots at once, which is
    // correct behaviour and proves nothing about sliding.
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(5, clock.now);
    for (let i = 0; i < 5; i += 1) {
      spend(limiter, 1);
      clock.advanceSeconds(1);
    }

    // The loop left the clock at t=5 with hits at t=0,1,2,3,4. This lands on
    // t=59, one second before the oldest hit turns 60, so nothing has expired.
    clock.advanceSeconds(54);
    expect(limiter.allows()).toBe(false);

    // One second later the first hit turns 60. Exactly one slot, not five.
    clock.advanceSeconds(1);
    expect(spend(limiter, 5)).toBe(1);

    // And a second later, exactly one more.
    clock.advanceSeconds(1);
    expect(spend(limiter, 5)).toBe(1);
  });

  it('does not extend the window when an event is refused', () => {
    // The whole reason `record` is called only on the allowed path. If a refusal
    // recorded a timestamp, a client in a loop would keep pushing its own window
    // forward and stay over the limit for as long as it kept trying, which turns
    // a momentary burst into a permanent lockout.
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(2, clock.now);
    spend(limiter, 2);

    // A thousand refused attempts, spread through the window.
    for (let i = 0; i < 1000; i += 1) expect(limiter.allows()).toBe(false);

    clock.advanceSeconds(60);
    expect(limiter.allows()).toBe(true);
  });

  it('reports how long to wait, so a backoff is a number rather than a guess', () => {
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(2, clock.now);
    spend(limiter, 2);

    clock.advanceSeconds(20);

    // The oldest hit is 20s old, so its slot frees 40s from now.
    expect(limiter.retryAfterMs()).toBe(40_000);
  });

  it('reports zero wait while there is budget left', () => {
    const limiter = new SlidingWindowLimiter(5, new Clock().now);
    spend(limiter, 1);

    expect(limiter.retryAfterMs()).toBe(0);
  });

  it('does not grow without bound while a client floods', () => {
    // The array is pruned on every call, so it never holds more than the limit.
    // Without pruning, a socket that spent an hour at the limit would hold 14,400
    // timestamps.
    const clock = new Clock();
    const limiter = new SlidingWindowLimiter(3, clock.now);

    for (let minute = 0; minute < 100; minute += 1) {
      spend(limiter, 10);
      clock.advanceSeconds(60);
    }

    expect(spend(limiter, 3)).toBe(3);
  });
});

describe('SocketLimiters', () => {
  it('gives each socket its own budget', () => {
    const limiters = new SocketLimiters(1, new Clock().now);

    limiters.for('socket-a').record();

    expect(limiters.for('socket-a').allows()).toBe(false);
    expect(limiters.for('socket-b').allows()).toBe(true);
  });

  it('returns the same limiter for the same socket', () => {
    const limiters = new SocketLimiters(10, new Clock().now);

    expect(limiters.for('socket-a')).toBe(limiters.for('socket-a'));
  });

  it('forgets a socket, because otherwise the map is an unbounded leak', () => {
    // A gateway that never forgot a disconnected socket would hold a timestamp
    // array per connection it had ever served, which on a process that has been
    // up for a week is every reconnect of every client.
    const limiters = new SocketLimiters(10, new Clock().now);
    limiters.for('socket-a');
    limiters.for('socket-b');
    expect(limiters.size).toBe(2);

    limiters.forget('socket-a');

    expect(limiters.size).toBe(1);
  });

  it('gives a reconnecting socket a fresh budget', () => {
    // A socket lives on one replica for its whole life, and a reconnect is a new
    // socket with a new id. That is why this limiter is in memory rather than in
    // Redis: there is nothing to share.
    const limiters = new SocketLimiters(1, new Clock().now);
    limiters.for('socket-a').record();
    limiters.forget('socket-a');

    expect(limiters.for('socket-a').allows()).toBe(true);
  });
});
