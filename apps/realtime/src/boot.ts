/**
 * Everything that must be true before the gateway accepts its first connection.
 *
 * The property this file exists to hold: **every reason the process will not work
 * is discovered before it is listening.** A gateway that binds its port and then
 * fails on the first `message.send` looks healthy to a container runtime, passes a
 * liveness probe, and takes traffic it cannot serve. Failing here instead means
 * the process exits with a sentence naming what is wrong.
 *
 * ---------------------------------------------------------------------------
 * Two Redis connections, and why they cannot be one
 *
 * `@socket.io/redis-adapter` needs a publisher and a subscriber. This is not a
 * throughput choice: a Redis client that has issued `SUBSCRIBE` is in subscriber
 * mode and **refuses every other command**, so a single shared client would either
 * fail to publish or fail to subscribe depending on which happened first, and the
 * symptom would be that broadcasts stop crossing between replicas while everything
 * on the local process keeps working.
 *
 * `.duplicate()` rather than a second `new Redis(url)`, so options cannot drift
 * between the two. A retry strategy set on one and not the other is a pair that
 * behaves differently under exactly the conditions the pair exists for.
 *
 * ---------------------------------------------------------------------------
 * An `error` listener on both, before anything else
 *
 * ioredis emits `error` on a blip. An `EventEmitter` with no `error` listener
 * **throws**, which in Node is an uncaught exception and takes the process down.
 * A gateway that dies because Redis hiccuped for 200ms drops every socket it was
 * holding, and each of those clients reconnects and asks for a catch-up, which is
 * a reconnect storm produced by a transient network event.
 */
import { PrismaClient } from '@chat/db';
import { Redis } from 'ioredis';

import type { RealtimeConfig } from './config';

export class BootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootError';
  }
}

/**
 * Semantic checks a schema cannot express.
 *
 * `loadConfig` proves each value is well formed on its own. These are the ones
 * about how two values relate, which is where the misconfigurations that actually
 * happen live.
 */
export function assertBootable(config: RealtimeConfig): void {
  // The same rule `services/presence` enforces in its own constructor, checked
  // here as well and on purpose. The constructor runs when the gateway first
  // touches presence, which is after it has started listening and answered a
  // health check; a process that accepts connections and then throws on
  // somebody's first heartbeat is far harder to diagnose than one that refused
  // to start.
  if (config.presenceTtlSeconds <= config.presenceHeartbeatSeconds * 2) {
    throw new BootError(
      `PRESENCE_TTL_SECONDS (${String(config.presenceTtlSeconds)}) must be more than twice ` +
        `PRESENCE_HEARTBEAT_SECONDS (${String(config.presenceHeartbeatSeconds)}). At or below ` +
        '2x, one dropped heartbeat marks somebody offline who is still reading.',
    );
  }

  // A catch-up that cannot cover a page of history is a client that reloads the
  // channel every time it reconnects, because the first thing it does after a
  // reload is ask for the page it just failed to splice.
  if (config.catchUpMaxMessages < config.historyPageSize) {
    throw new BootError(
      `CATCHUP_MAX_MESSAGES (${String(config.catchUpMaxMessages)}) must be at least ` +
        `HISTORY_PAGE_SIZE (${String(config.historyPageSize)}), or every reconnect that missed ` +
        'one page answers TOO_FAR_BEHIND and forces a reload.',
    );
  }

  // The body limit in the contract is 4000 characters, which is at most 16000
  // bytes of UTF-8. A frame ceiling below that would reject valid messages at the
  // transport, where the client gets a disconnect rather than a sentence it can
  // show somebody.
  const maxBodyBytes = 4000 * 4;
  if (config.socketMaxPayloadBytes < maxBodyBytes) {
    throw new BootError(
      `SOCKET_MAX_PAYLOAD_BYTES (${String(config.socketMaxPayloadBytes)}) is below the ` +
        `${String(maxBodyBytes)} bytes a maximum-length message body can occupy, so a legal ` +
        'message would be refused by the transport instead of by the contract.',
    );
  }
}

export interface Connections {
  prisma: PrismaClient;
  /** Publishes broadcasts to the other replicas. Never in subscriber mode. */
  pub: Redis;
  /** Receives them. In subscriber mode, and therefore useless for anything else. */
  sub: Redis;
}

/**
 * Open every connection, eagerly, and fail if any of them will not open.
 *
 * `$connect()` rather than letting the first query connect lazily: Prisma's lazy
 * connect turns "the database is unreachable" into an error on whichever request
 * happened to be first, which is a user-facing failure for an operational fact
 * that was true before the process started.
 */
export async function connect(config: RealtimeConfig): Promise<Connections> {
  const prisma = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });

  const pub = new Redis(config.redisUrl, {
    // Fail rather than queue. The default buffers commands issued before the
    // connection is up and replays them, which would let this function return
    // successfully against a Redis that is not there.
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  const sub = pub.duplicate();

  // Attached before `connect()`, not after: a connection that fails immediately
  // emits `error` synchronously enough to beat a listener added on the next line.
  pub.on('error', (error) => {
    console.error('[realtime] redis publisher error', error);
  });
  sub.on('error', (error) => {
    console.error('[realtime] redis subscriber error', error);
  });

  try {
    await Promise.all([prisma.$connect(), pub.connect(), sub.connect()]);
  } catch (error) {
    // Everything opened so far is closed before rethrowing. Without this, a
    // process that failed to boot holds a Postgres connection until the
    // supervisor kills it, and a crash loop exhausts the connection pool.
    await Promise.allSettled([prisma.$disconnect(), pub.quit(), sub.quit()]);
    throw new BootError(
      `Cannot reach a dependency: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return { prisma, pub, sub };
}
