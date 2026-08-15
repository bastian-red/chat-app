/**
 * The pure core of every socket event: refuse, parse, run, answer.
 *
 * Separated from `gateway.ts` so the decisions can be tested without a socket
 * server, a database or Redis. What lives here is the order those four steps
 * happen in and what each failure turns into on the wire. What lives in
 * `gateway.ts` is the wiring.
 *
 * ---------------------------------------------------------------------------
 * The order is the design
 *
 *   1. **rate limit** -- before the payload is even parsed. Refusal must be the
 *      cheapest path in the process, or a client in a loop costs a zod parse and
 *      a database round trip per frame and the limiter protects nothing.
 *   2. **parse** -- once, at the boundary, with the schema from `@chat/shared`.
 *      Everything downstream trusts the value.
 *   3. **run** -- the handler, which is where a permission check and a call into
 *      `services/messaging` happen.
 *   4. **answer** -- always, through the ack. Every client event is acknowledged
 *      (`docs/SPECS.md` section 4.3): a fire-and-forget event has nowhere to
 *      report `RATE_LIMITED` or `FORBIDDEN`, and `message.send` additionally needs
 *      the ack to carry the allocated seq.
 *
 * ---------------------------------------------------------------------------
 * What the client is told, and what it is not
 *
 * **Zod's issues never reach the wire.** A validation failure answers a fixed
 * `INVALID` sentence. The issue list names internal field paths and, for a body
 * that failed a length rule, quotes the input back -- and this is a chat, so the
 * input is somebody's message. The detail goes to the server's log through
 * `onInternal`, where it is diagnosable.
 *
 * **An unknown throw becomes `INTERNAL` with a fixed sentence.** Same reasoning,
 * stronger: an unmapped error is by definition one nobody has read, so its message
 * could be a connection string. `INTERNAL` is the only code allowed to be vague
 * and the only one whose text is not shown to the user.
 *
 * **A `MessagingError` keeps its code and its message.** Those messages are
 * written to be read by a person ("You cannot post in this channel."), which is
 * the whole reason `services/messaging` throws codes rather than prose.
 */
import { MessagingError } from '@chat/messaging';
import type { Ack, ErrorCode, SocketError } from '@chat/shared';
import { z } from 'zod';

import type { SlidingWindowLimiter } from './rate-limit';

/**
 * The sentence a client sees when its payload failed the schema.
 *
 * Fixed, and identical for every event. See the header: the alternative leaks
 * field paths and quotes message bodies back over a socket.
 */
export const INVALID_MESSAGE = 'That request was not in a shape this server accepts.';

/** The sentence for an error nobody has classified. */
export const INTERNAL_MESSAGE = 'Something went wrong on the server.';

export interface DispatchDeps {
  limiter: SlidingWindowLimiter;
  /**
   * Where an unexpected failure goes.
   *
   * A callback rather than `console.error` here so the gate lane can assert that
   * the detail was reported *and* that it did not reach the client. Those are two
   * different properties and a direct console call proves neither.
   */
  onInternal: (event: string, error: unknown) => void;
}

export function socketError(code: ErrorCode, message: string, event?: string): SocketError {
  return event === undefined ? { code, message } : { code, message, event };
}

/**
 * Run one client event end to end.
 *
 * Never throws. Every path returns an `Ack`, because the caller's only job after
 * this is to hand the result to the socket's ack callback, and a throw there would
 * leave the client waiting for an answer that is never sent -- which presents as a
 * message that appears to be sending forever.
 */
export async function dispatch<TPayload, TResult>(
  event: string,
  raw: unknown,
  schema: z.ZodType<TPayload>,
  handler: (payload: TPayload) => Promise<TResult>,
  deps: DispatchDeps,
): Promise<Ack<TResult>> {
  // 1. Refusal before work.
  if (!deps.limiter.allows()) {
    const seconds = Math.ceil(deps.limiter.retryAfterMs() / 1000);
    return {
      ok: false,
      error: socketError(
        'RATE_LIMITED',
        `Too many events on this connection. Try again in ${String(seconds)}s.`,
        event,
      ),
    };
  }
  // Recorded here, where the event was allowed, and nowhere else. Recording a
  // refusal would let a client in a loop hold itself over the limit forever.
  deps.limiter.record();

  // 2. Parse once, at the boundary.
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    deps.onInternal(event, parsed.error);
    return { ok: false, error: socketError('INVALID', INVALID_MESSAGE, event) };
  }

  // 3. Run, and 4. answer.
  try {
    return { ok: true, data: await handler(parsed.data) };
  } catch (error) {
    if (error instanceof MessagingError) {
      return { ok: false, error: socketError(error.code, error.message, event) };
    }
    deps.onInternal(event, error);
    return { ok: false, error: socketError('INTERNAL', INTERNAL_MESSAGE, event) };
  }
}

/**
 * How a catch-up request is answered, given what the repository fetched.
 *
 * Pure, and separated from the handler that calls it, because it is the one piece
 * of arithmetic in the protocol that is easy to get wrong by one and impossible to
 * see wrong from the outside.
 *
 * The repository is asked for `max + 1` rows on purpose. Fetching exactly `max`
 * and answering `complete: rows.length < max` cannot tell "there were exactly max"
 * from "there were more", and the first of those is a correct splice while the
 * second is a channel reload. The extra row settles it and is then dropped.
 *
 * `complete: false` is not an error and is not `TOO_FAR_BEHIND` on its own: the
 * client reloads the channel rather than splicing what it was given
 * (`docs/SPECS.md` section 4.4), which is why the messages are still returned.
 */
export function boundCatchUp<T>(
  fetched: readonly T[],
  max: number,
): { messages: T[]; complete: boolean } {
  if (fetched.length > max) {
    return { messages: fetched.slice(0, max), complete: false };
  }
  return { messages: [...fetched], complete: true };
}
