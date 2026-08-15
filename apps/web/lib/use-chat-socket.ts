'use client';

/**
 * One socket for the whole app.
 *
 * Two details in here are load-bearing and neither is obvious from the Socket.io
 * documentation.
 *
 * **`auth` is a callback, not a value.** Socket.io calls it before *every*
 * connection attempt, including every reconnect. A service token lives 120
 * seconds (`SERVICE_TOKEN_TTL_SECONDS`), so a token captured once as a value works
 * until the first reconnect after two minutes and is rejected forever after. The
 * symptom is a conversation that works, drops, and never comes back, with the
 * reconnect loop failing silently.
 *
 * **Cleanup calls `removeAllListeners()` before `close()`.** React strict mode
 * mounts every effect twice in development. Without the removal, the second mount
 * attaches a second copy of every handler to a socket the first mount already
 * wired, and every message is then processed twice -- which the reorder buffer
 * hides for stored messages and does not hide for typing indicators or presence.
 *
 * The token is fetched from this app's own route rather than embedded in the page.
 * Embedding it would put a credential in the HTML, where it survives in the
 * browser's cache and in any screenshot of the page source, and it would be stale
 * two minutes after the render.
 */
import { CLIENT_EVENTS, SERVER_EVENTS, type Ack } from '@chat/shared';
import { io, type Socket } from 'socket.io-client';
import { useCallback, useEffect, useRef, useState } from 'react';

import { publicRealtimeUrl } from './config';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

/**
 * A server-event handler.
 *
 * One loose signature rather than one per event. Writing them out would be a
 * second declaration of the protocol beside
 * `packages/shared/src/contracts/events.ts`, and two declarations of one protocol
 * is the failure this codebase spends the most effort avoiding. The payloads are
 * typed where it matters: every caller annotates its own parameter from the same
 * contract the gateway builds the payload with.
 */
export type SocketHandler = (payload: never) => void;

export interface ChatSocket {
  state: ConnectionState;
  /** Emit and wait for the ack. Rejects only on a transport failure. */
  send: <T>(event: string, payload: unknown) => Promise<Ack<T>>;
  on: (event: string, handler: SocketHandler) => () => void;
}

/**
 * Fetch a fresh service token.
 *
 * A route on this app rather than a value baked into the page: the token is a
 * credential with a two-minute life, and the mint needs `AUTH_SECRET`, which must
 * never reach the browser.
 */
async function fetchToken(): Promise<string> {
  const response = await fetch('/api/socket-token', { cache: 'no-store' });
  if (!response.ok) throw new Error('Could not mint a socket token.');
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string') throw new Error('The token route answered no token.');
  return body.token;
}

export function useChatSocket(enabled: boolean): ChatSocket {
  const [state, setState] = useState<ConnectionState>('connecting');
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const socket = io(publicRealtimeUrl, {
      // The callback form. See the module header: a value here is a token that
      // goes stale on the first reconnect past its two-minute life.
      auth: (callback: (data: Record<string, unknown>) => void) => {
        void fetchToken()
          .then((token) => {
            callback({ token });
          })
          .catch(() => {
            // An empty token fails the handshake, which is the honest outcome:
            // the alternative is not calling back at all, and the connection
            // attempt would hang rather than fail.
            callback({ token: '' });
          });
      },
      transports: ['websocket'],
      // Reconnection left on, with a ceiling. A gateway restart is routine and a
      // client that gave up would need a page reload to come back.
      reconnection: true,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setState('connected');
    });
    socket.on('disconnect', () => {
      setState('disconnected');
    });
    socket.on('connect_error', () => {
      setState('disconnected');
    });
    socket.on(SERVER_EVENTS.error, (payload: { code: string; message: string }) => {
      // Server errors that arrive with no ack to carry them. Logged rather than
      // rendered: they are the fire-and-forget path, and the events that matter
      // to a person all have acks.
      console.warn('[chat] server error', payload.code, payload.message);
    });

    return () => {
      // Order matters. See the module header: strict mode's double mount is what
      // this protects against, and reversing these two lines makes it a no-op.
      socket.removeAllListeners();
      socket.close();
      socketRef.current = null;
    };
  }, [enabled]);

  const send = useCallback(<T>(event: string, payload: unknown): Promise<Ack<T>> => {
    const socket = socketRef.current;
    if (!socket) {
      return Promise.resolve({
        ok: false,
        error: { code: 'INTERNAL', message: 'Not connected yet.', event },
      });
    }

    return new Promise((resolve) => {
      // A timeout, because a handler that never acks would leave a message
      // rendering as "sending" forever with nothing to retry.
      const timer = setTimeout(() => {
        resolve({
          ok: false,
          error: { code: 'INTERNAL', message: 'The server did not answer.', event },
        });
      }, 15_000);

      socket.emit(event, payload, (ack: Ack<T>) => {
        clearTimeout(timer);
        resolve(ack);
      });
    });
  }, []);

  const on = useCallback((event: string, handler: SocketHandler) => {
    const socket = socketRef.current;
    if (!socket) return () => undefined;
    // Socket.io types its listener as `(...args: any[]) => void`, which a
    // narrower handler is not assignable to. The cast is contained here, at the
    // one boundary, rather than at every call site.
    const listener = handler as (...args: unknown[]) => void;
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, []);

  return { state, send, on };
}

export { CLIENT_EVENTS, SERVER_EVENTS };
