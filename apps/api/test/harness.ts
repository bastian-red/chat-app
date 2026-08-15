/**
 * What every integration file needs: a database handle, a seeded fixture, a
 * signed token, and a socket that is actually connected.
 *
 * Kept out of the specs because four files want the same five helpers, and a
 * helper copied into four specs is four helpers that drift. Nothing here asserts;
 * it only sets things up, so a failure in this file is a failure of the harness
 * and reads as one.
 */
import { PrismaClient, PrismaMessagingRepository } from '@chat/db';
import { io, type Socket } from 'socket.io-client';
import { mintServiceToken } from '@chat/shared/server';
import type { Ack } from '@chat/shared';

/** One client for the whole lane. `fileParallelism: false` makes that safe. */
export const prisma = new PrismaClient();
export const repository = new PrismaMessagingRepository(prisma);

export const AUTH_SECRET = process.env.AUTH_SECRET ?? 'ci-secret-at-least-32-characters-long';
export const GATEWAY_1 = process.env.REALTIME_BASE_URL ?? 'http://localhost:4100';
/**
 * The second replica.
 *
 * Falls back to the first, so the file still runs on a machine that started one
 * gateway. The cross-replica spec checks whether the two URLs are actually
 * different and says so rather than passing vacuously, because a suite that
 * silently tests one process against itself is the exact failure this project's
 * headline claim would hide behind.
 */
export const GATEWAY_2 = process.env.REALTIME_BASE_URL_2 ?? GATEWAY_1;

export interface Person {
  id: string;
  email: string;
  name: string;
  token: string;
}

/** The demo account, and the three others the seed creates. */
export async function person(email: string): Promise<Person> {
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    // A real token, minted the way the web app mints one. Not a fixture: the
    // handshake verifies the signature, so a hand-written string would fail for a
    // reason that has nothing to do with what is under test.
    token: mintServiceToken({ id: user.id, email: user.email, name: user.name }, AUTH_SECRET),
  };
}

export async function channelBySlug(slug: string): Promise<{ id: string; nextSeq: number }> {
  const channel = await prisma.channel.findUniqueOrThrow({ where: { slug } });
  return { id: channel.id, nextSeq: Number(channel.nextSeq) };
}

/**
 * A connected socket, or a rejection naming why the handshake failed.
 *
 * Resolving only on `connect` matters: `io()` returns immediately and a test that
 * started sending on the returned object would race the handshake and fail with a
 * timeout that says nothing about the token.
 */
export function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      auth: { token },
      // WebSocket only. The default tries long-polling first and upgrades, which
      // adds a second connection per client and makes a "did the broadcast
      // arrive" assertion race the upgrade.
      transports: ['websocket'],
      reconnection: false,
      timeout: 10_000,
    });
    socket.on('connect', () => {
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      socket.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

/**
 * Emit and wait for the ack.
 *
 * Every client event is acknowledged (`docs/SPECS.md` section 4.3), so a helper
 * that returns the ack is the natural shape. The timeout is explicit because the
 * failure it catches -- a handler that never calls back -- otherwise presents as
 * the whole file hanging until vitest's own timeout, with no indication of which
 * event stalled.
 */
export function emit<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`No ack for ${event} within 10s.`));
    }, 10_000);

    socket.emit(event, payload, (ack: Ack<T>) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

/** The success branch, or a failure naming the code the server sent. */
export function expectOk<T>(ack: Ack<T>, what: string): T {
  if (!ack.ok) throw new Error(`${what} was refused: ${ack.error.code} ${ack.error.message}`);
  return ack.data;
}

/**
 * Wait for one server event that satisfies a predicate.
 *
 * A predicate rather than "the next one", because a channel with several clients
 * in it delivers events the caller did not cause. Taking the first arrival would
 * make a passing assertion depend on nobody else's timing.
 */
export function waitFor<T>(
  socket: Socket,
  event: string,
  matches: (payload: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`No ${event} matching the predicate within ${String(timeoutMs)}ms.`));
    }, timeoutMs);

    function onEvent(payload: T): void {
      if (!matches(payload)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(payload);
    }

    socket.on(event, onEvent);
  });
}

/** Close a set of sockets without caring whether they were already closed. */
export function closeAll(...sockets: (Socket | undefined)[]): void {
  for (const socket of sockets) {
    // `removeAllListeners` before `close`. A listener still attached during
    // teardown can fire on the disconnect and reject a promise nobody is holding,
    // which vitest reports as an unhandled rejection in whichever test happens to
    // be running next.
    socket?.removeAllListeners();
    socket?.close();
  }
}

/**
 * A throwaway channel, so a spec that writes cannot disturb the seeded digest.
 *
 * Named with the caller's label plus a counter rather than a random suffix, so a
 * failure names a channel somebody can find in the database afterwards.
 */
let scratchCounter = 0;
export async function scratchChannel(label: string, memberIds: string[]): Promise<{ id: string }> {
  scratchCounter += 1;
  const slug = `it-${label}-${String(scratchCounter)}-${String(Date.now())}`;
  const channel = await prisma.channel.create({
    data: {
      kind: 'PUBLIC',
      slug,
      name: `Integration ${label} ${String(scratchCounter)}`,
      createdById: memberIds[0] ?? null,
      members: {
        create: memberIds.map((userId, index) => ({
          userId,
          role: index === 0 ? ('OWNER' as const) : ('MEMBER' as const),
        })),
      },
    },
  });
  return { id: channel.id };
}
