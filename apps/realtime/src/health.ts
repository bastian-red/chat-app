/**
 * `GET /health` for the gateway.
 *
 * The one thing that makes this different from the API's health check, and the
 * reason it is worth its own file: **it round-trips a nonce through the adapter's
 * own two Redis connections** rather than sending `PING` on a third client.
 *
 * A `PING` proves Redis is reachable from this process. It does not prove the
 * pub/sub path works, and pub/sub is the only thing that makes two gateway
 * replicas one logical server. A gateway whose subscriber has silently stopped
 * receiving keeps serving every socket it holds perfectly well and stops
 * delivering anything to the other replica. From inside that process nothing is
 * wrong; from a user's seat, half the people in a channel stopped talking. That is
 * this product's worst failure and a liveness probe cannot see it.
 *
 * So the check publishes a random string on a dedicated channel and waits for its
 * own subscriber to hand it back. Failing that is a 503.
 *
 * `status` is `degraded` and the code is 503 when any check fails. Both matter:
 * `scripts/dev-smoke.sh` reads the body because a 503 naming the failed check is
 * far more useful than a bare code, and `infra/Dockerfile.realtime`'s HEALTHCHECK
 * reads the code because a container runtime cannot parse JSON.
 */
import type { HealthCheck, RealtimeHealth } from '@chat/shared';
import type { PrismaClient } from '@chat/db';
import type { Redis } from 'ioredis';

/**
 * The pub/sub channel the probe uses.
 *
 * Distinct from anything `@socket.io/redis-adapter` publishes on, so a health
 * probe can never be mistaken for a broadcast by a replica running an older build.
 */
const PROBE_CHANNEL = 'chat:health:probe';

/**
 * How long the round trip may take before it is a failure.
 *
 * Two seconds. Local Redis answers in under a millisecond, so anything near this
 * is already a problem; the number exists so the check cannot hang, because a
 * health endpoint that never answers is read by every orchestrator as a failure
 * anyway, just slower and with a socket held open.
 */
const PROBE_TIMEOUT_MS = 2000;

export interface HealthDeps {
  prisma: PrismaClient;
  pub: Redis;
  sub: Redis;
  version: string;
  startedAt: number;
  /** Live counts from the Socket.io server. Read at request time, never cached. */
  counts: () => { connectedSockets: number; rooms: number };
  now?: () => number;
}

async function timed(
  name: string,
  run: () => Promise<void>,
  now: () => number,
): Promise<HealthCheck> {
  const started = now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: now() - started,
      // The message, not the stack. This body is read by a developer running
      // dev-smoke and by the /status page; a stack would be neither.
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Publish a nonce and wait for the subscriber to deliver it back.
 *
 * Subscribes for the duration of the probe and unsubscribes afterwards rather
 * than holding a permanent subscription. A permanent one would mean the health
 * path shared state with itself across concurrent requests, and two probes in
 * flight would each be able to satisfy themselves with the other's nonce.
 */
async function pubSubRoundTrip(pub: Redis, sub: Redis): Promise<void> {
  const nonce = `${String(Date.now())}:${Math.random().toString(36).slice(2)}`;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `No pub/sub round trip within ${String(PROBE_TIMEOUT_MS)}ms. This gateway is not ` +
            'relaying to the other replicas.',
        ),
      );
    }, PROBE_TIMEOUT_MS);

    const onMessage = (channel: string, payload: string): void => {
      if (channel !== PROBE_CHANNEL || payload !== nonce) return;
      cleanup();
      resolve();
    };

    function cleanup(): void {
      clearTimeout(timer);
      sub.off('message', onMessage);
      // Fire and forget: the probe has already succeeded or failed, and an
      // unsubscribe that fails must not turn a green check red.
      void sub.unsubscribe(PROBE_CHANNEL).catch(() => undefined);
    }

    sub.on('message', onMessage);
    sub
      .subscribe(PROBE_CHANNEL)
      .then(() => pub.publish(PROBE_CHANNEL, nonce))
      .catch((error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
  });
}

export async function realtimeHealth(deps: HealthDeps): Promise<RealtimeHealth> {
  const now = deps.now ?? Date.now;

  const checks = await Promise.all([
    // A real query, not a pool handle. `SELECT 1` goes to the server and back, so
    // a connection that the driver believes is open but that Postgres has closed
    // fails here rather than on somebody's first message.
    timed(
      'postgres',
      async () => {
        await deps.prisma.$queryRaw`SELECT 1`;
      },
      now,
    ),
    timed(
      'redis',
      async () => {
        await deps.pub.ping();
      },
      now,
    ),
    timed('adapter', () => pubSubRoundTrip(deps.pub, deps.sub), now),
  ]);

  const counts = deps.counts();

  return {
    status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
    version: deps.version,
    uptimeSeconds: Math.floor((now() - deps.startedAt) / 1000),
    checks,
    // Not a check, and deliberately not one: zero sockets is normal on a gateway
    // nobody has opened yet. It is here because it is the first question anybody
    // asks about a replica, and a green tick with zero sockets after a deploy is
    // either idle or unreachable.
    connectedSockets: counts.connectedSockets,
    rooms: counts.rooms,
  };
}

/** 200 when every check passed, 503 otherwise. The Docker probe reads only this. */
export function healthStatusCode(health: RealtimeHealth): number {
  return health.status === 'ok' ? 200 : 503;
}
