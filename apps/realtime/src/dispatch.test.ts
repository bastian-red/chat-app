/**
 * What a client is told, and what it is not.
 *
 * Two kinds of assertion live here and the second kind is the reason this file
 * exists. The first is ordinary: a good payload runs the handler, a
 * `MessagingError` keeps its code. The second is negative -- the zod issue list
 * and an unmapped error message must **not** appear on the wire. A leak there is
 * invisible in every manual test, because the client renders whatever it is given
 * and nothing looks broken.
 */
import { MessagingError } from '@chat/messaging';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { INTERNAL_MESSAGE, INVALID_MESSAGE, boundCatchUp, dispatch } from './dispatch';
import { SlidingWindowLimiter } from './rate-limit';

const schema = z.object({ channelId: z.string().min(1), body: z.string().min(1) });

function deps(limit = 100) {
  const onInternal = vi.fn();
  return { limiter: new SlidingWindowLimiter(limit), onInternal };
}

describe('dispatch', () => {
  it('runs the handler and returns its result on the success branch', async () => {
    const result = await dispatch(
      'message.send',
      { channelId: 'c1', body: 'hello' },
      schema,
      (payload) => Promise.resolve({ echoed: payload.body }),
      deps(),
    );

    expect(result).toEqual({ ok: true, data: { echoed: 'hello' } });
  });

  it('hands the handler the parsed value, not the raw one', async () => {
    // Parse once, at the boundary, then trust the value. A handler that received
    // the raw input would be a second place validation could be forgotten.
    const trimming = z.object({ body: z.string().trim() });
    const handler = vi.fn(() => Promise.resolve({}));

    await dispatch('message.send', { body: '  hi  ' }, trimming, handler, deps());

    expect(handler).toHaveBeenCalledWith({ body: 'hi' });
  });

  describe('refusal before work', () => {
    it('refuses with RATE_LIMITED once the budget is spent', async () => {
      const context = deps(1);
      const handler = vi.fn(() => Promise.resolve({}));
      const payload = { channelId: 'c1', body: 'hello' };

      await dispatch('message.send', payload, schema, handler, context);
      const second = await dispatch('message.send', payload, schema, handler, context);

      expect(second).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not parse a refused payload', async () => {
      // The ordering that makes the limiter worth having. If parsing came first,
      // a client in a loop would cost a zod parse per frame and the limiter would
      // protect the database and nothing else.
      const context = deps(1);
      const spy = vi.spyOn(schema, 'safeParse');
      const payload = { channelId: 'c1', body: 'hello' };

      await dispatch('message.send', payload, schema, () => Promise.resolve({}), context);
      spy.mockClear();
      await dispatch('message.send', payload, schema, () => Promise.resolve({}), context);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('names the event, so a client with several in flight can tell them apart', async () => {
      const context = deps(1);
      await dispatch('message.send', {}, schema, () => Promise.resolve({}), context);
      const refused = await dispatch(
        'typing.start',
        {},
        schema,
        () => Promise.resolve({}),
        context,
      );

      expect(refused).toMatchObject({ ok: false, error: { event: 'typing.start' } });
    });

    it('tells the client how long to back off', async () => {
      const context = deps(1);
      await dispatch('message.send', {}, schema, () => Promise.resolve({}), context);
      const refused = await dispatch(
        'message.send',
        {},
        schema,
        () => Promise.resolve({}),
        context,
      );

      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toMatch(/Try again in \d+s\./u);
    });
  });

  describe('a bad payload', () => {
    it('answers INVALID', async () => {
      const result = await dispatch(
        'message.send',
        { channelId: 'c1' },
        schema,
        () => Promise.resolve({}),
        deps(),
      );

      expect(result).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    });

    it('never puts the zod issues on the wire', async () => {
      // The issue list names internal field paths and, for a body that failed a
      // length rule, quotes the input back. This is a chat, so that input is
      // somebody's message.
      const result = await dispatch(
        'message.send',
        { channelId: '', body: 'secret text' },
        schema,
        () => Promise.resolve({}),
        deps(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(INVALID_MESSAGE);
        expect(result.error.message).not.toContain('channelId');
        expect(result.error.message).not.toContain('secret text');
      }
    });

    it('reports the detail to the server instead', async () => {
      const context = deps();

      await dispatch('message.send', {}, schema, () => Promise.resolve({}), context);

      expect(context.onInternal).toHaveBeenCalledOnce();
      expect(context.onInternal.mock.calls[0]?.[0]).toBe('message.send');
    });

    it('does not run the handler', async () => {
      const handler = vi.fn(() => Promise.resolve({}));

      await dispatch('message.send', { channelId: 'c1' }, schema, handler, deps());

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('a handler that throws', () => {
    it('keeps a MessagingError code and its message', async () => {
      // Those messages are written to be read by a person, which is the whole
      // reason services/messaging throws codes rather than prose.
      const result = await dispatch(
        'message.send',
        { channelId: 'c1', body: 'hello' },
        schema,
        () => Promise.reject(new MessagingError('FORBIDDEN', 'You cannot post in this channel.')),
        deps(),
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'FORBIDDEN',
          message: 'You cannot post in this channel.',
          event: 'message.send',
        },
      });
    });

    it.each([
      ['NOT_FOUND' as const],
      ['INVALID' as const],
      ['CONFLICT' as const],
      ['TOO_FAR_BEHIND' as const],
    ])('passes %s through unchanged', async (code) => {
      const result = await dispatch(
        'message.send',
        { channelId: 'c1', body: 'hello' },
        schema,
        () => Promise.reject(new MessagingError(code, 'nope')),
        deps(),
      );

      expect(result).toMatchObject({ ok: false, error: { code } });
    });

    it('turns an unmapped error into INTERNAL with a fixed sentence', async () => {
      // An unmapped error is by definition one nobody has read, so its message
      // could be a connection string. INTERNAL is the only code allowed to be
      // vague and the only one whose text is not shown to the user.
      const result = await dispatch(
        'message.send',
        { channelId: 'c1', body: 'hello' },
        schema,
        () =>
          Promise.reject(new Error('connect ECONNREFUSED postgresql://chat:chat@localhost:5438')),
        deps(),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INTERNAL');
        expect(result.error.message).toBe(INTERNAL_MESSAGE);
        expect(result.error.message).not.toContain('postgresql');
      }
    });

    it('logs the unmapped error rather than swallowing it', async () => {
      const context = deps();
      const thrown = new Error('boom');

      await dispatch(
        'message.send',
        { channelId: 'c1', body: 'hello' },
        schema,
        () => Promise.reject(thrown),
        context,
      );

      expect(context.onInternal).toHaveBeenCalledWith('message.send', thrown);
    });

    it('never throws, whatever the handler did', async () => {
      // A throw here would leave the ack unsent, and the client waiting for an
      // answer that never comes -- which presents as a message that appears to be
      // sending forever.
      await expect(
        dispatch(
          'message.send',
          { channelId: 'c1', body: 'hello' },
          schema,
          () => Promise.reject('a string, not an Error'),
          deps(),
        ),
      ).resolves.toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    });
  });
});

describe('boundCatchUp', () => {
  const rows = Array.from({ length: 12 }, (_, index) => index + 1);

  it('is complete when there is less than a full window', () => {
    expect(boundCatchUp(rows.slice(0, 3), 10)).toEqual({ messages: [1, 2, 3], complete: true });
  });

  it('is complete at exactly the ceiling', () => {
    // The case that needs the extra row. Fetching exactly `max` and answering
    // `complete: rows.length < max` cannot tell "there were exactly max" from
    // "there were more", and the first is a correct splice while the second is a
    // channel reload.
    expect(boundCatchUp(rows.slice(0, 10), 10)).toMatchObject({ complete: true });
  });

  it('is incomplete at one past the ceiling', () => {
    expect(boundCatchUp(rows.slice(0, 11), 10)).toMatchObject({ complete: false });
  });

  it('drops the extra rows rather than sending them', () => {
    const bounded = boundCatchUp(rows, 10);

    expect(bounded.messages).toHaveLength(10);
    expect(bounded.messages.at(-1)).toBe(10);
  });

  it('still returns the messages when incomplete', () => {
    // `complete: false` is not an error. The client reloads the channel rather
    // than splicing, and returning nothing would make that decision look like a
    // failure rather than a bound.
    expect(boundCatchUp(rows, 10).messages.length).toBeGreaterThan(0);
  });

  it('copies rather than aliasing the caller array', () => {
    const source = [1, 2, 3];
    const bounded = boundCatchUp(source, 10);

    bounded.messages.push(4);

    expect(source).toEqual([1, 2, 3]);
  });

  it('handles an empty answer, which is what a client at the head gets', () => {
    expect(boundCatchUp([], 10)).toEqual({ messages: [], complete: true });
  });
});
