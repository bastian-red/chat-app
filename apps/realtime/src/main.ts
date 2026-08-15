/**
 * The gateway's entry point: parse, assert, connect, listen, and shut down.
 *
 * The order is the whole file. Every reason this process cannot work is
 * discovered before `listen`, so a gateway that is listening is a gateway that
 * can serve. The alternative -- bind first, discover a missing `AUTH_SECRET` on
 * the first handshake -- produces a container a runtime calls healthy, a load
 * balancer sends traffic to, and a user experiences as a conversation that renders
 * and never moves.
 *
 * The HTTP server is created here rather than inside `gateway.ts` because two
 * things need it: Socket.io attaches to it, and `/health` is served from it. One
 * port, two protocols, which is what lets `infra/Dockerfile.realtime`'s
 * HEALTHCHECK reach the same process the sockets are on rather than a sidecar that
 * can be healthy while the gateway is not.
 */
import { PrismaMessagingRepository } from '@chat/db';
import { createServer } from 'node:http';

import { assertBootable, connect } from './boot';
import { createGateway } from './gateway';
import { healthStatusCode, realtimeHealth } from './health';
import { loadConfig } from './config';

/** How long a shutdown may take before the process exits anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

async function main(): Promise<void> {
  const config = loadConfig();
  // Before a single connection is opened. A configuration that cannot work must
  // not cost a Postgres handshake to discover.
  assertBootable(config);

  const connections = await connect(config);
  const repository = new PrismaMessagingRepository(connections.prisma);
  const startedAt = Date.now();

  const httpServer = createServer((request, response) => {
    // Everything that is not /health is a 404. This process serves sockets; a
    // stray REST call reaching it is a misrouted client, and answering it with
    // anything but a 404 would hide that.
    if (request.url?.split('?')[0] !== '/health') {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    void (async () => {
      try {
        const health = await realtimeHealth({
          prisma: connections.prisma,
          pub: connections.pub,
          sub: connections.sub,
          version: config.appVersion,
          startedAt,
          counts: gateway.counts,
        });
        response.writeHead(healthStatusCode(health), { 'content-type': 'application/json' });
        response.end(JSON.stringify(health));
      } catch (error) {
        // A health endpoint that throws is read by every orchestrator as a
        // failure anyway; answering 503 with a sentence is the same verdict and a
        // diagnosable one.
        console.error('[realtime] health check threw', error);
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'degraded', checks: [] }));
      }
    })();
  });

  const gateway = createGateway({ config, connections, repository, httpServer });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, resolve);
  });
  console.warn(`[realtime] listening on :${String(config.port)}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    // Guarded: a container runtime sends SIGTERM and then SIGKILL, and an
    // orchestrator restarting a pod can deliver two signals in the same tick.
    // Running the teardown twice closes connections the second pass then throws
    // on.
    if (shuttingDown) return;
    shuttingDown = true;
    console.warn(`[realtime] ${signal} received, draining`);

    // Exits even if a drain hangs. A gateway holding a socket whose client has
    // gone would otherwise keep the process alive until the runtime kills it,
    // which turns a rolling restart into a stall.
    const timer = setTimeout(() => {
      console.error('[realtime] drain did not finish in time, exiting anyway');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();

    void (async () => {
      try {
        // Sockets first, then the things they talk to. Closing Redis first would
        // make every in-flight broadcast fail on its way out.
        await gateway.close();
        await Promise.allSettled([
          connections.prisma.$disconnect(),
          connections.pub.quit(),
          connections.sub.quit(),
        ]);
        clearTimeout(timer);
        process.exit(0);
      } catch (error) {
        console.error('[realtime] shutdown failed', error);
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // The message alone, not the stack: `ConfigError` and `BootError` are written
  // to be read by whoever is starting the process, and a stack in front of "fix
  // these in .env" buries the one line that matters.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
