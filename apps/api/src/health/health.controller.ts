/**
 * `GET /health`.
 *
 * Three checks, and each one is a real operation rather than a handle:
 *
 * - **Postgres** runs `SELECT 1`. A pool that believes it is connected to a
 *   server that closed the socket answers a liveness check perfectly and fails on
 *   the next query.
 * - **Redis** sends `PING`.
 * - **The upload directory** is *written to*. `existsSync` passes on a directory
 *   owned by root and on a read-only mount, and both of those fail on the first
 *   attachment. The question this endpoint answers is "can this process store a
 *   file", and the only honest way to ask it is to store one.
 *
 * 503 when any check fails, and the failing check is named in the body. Both
 * halves matter: `scripts/dev-smoke.sh` reads the body, because a 503 naming the
 * dead dependency is far more useful than a bare code, and
 * `infra/Dockerfile.api`'s HEALTHCHECK reads the status code, because a container
 * runtime cannot parse JSON.
 *
 * `@Public()`, because a probe that needed a credential is a probe a container
 * runtime cannot run. It reports dependency status and no data.
 */
import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import type { Health, HealthCheck } from '@chat/shared';
import type { Response } from 'express';

import { API_CONFIG, type ApiConfig } from '../config/config';
import { Public } from '../common/session.guard';
import { PrismaService } from '../infra/prisma.service';
import { RedisService } from '../infra/redis.service';
import { assertUploadsWritable } from '../config/boot';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Public()
  @Get()
  async health(@Res() response: Response): Promise<void> {
    const checks = await Promise.all([
      timed('postgres', async () => {
        await this.prisma.$queryRaw`SELECT 1`;
      }),
      timed('redis', async () => {
        await this.redis.client.ping();
      }),
      timed('uploads', () => assertUploadsWritable(this.config)),
    ]);

    const body: Health = {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'degraded',
      version: this.config.appVersion,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      checks,
    };

    response
      .status(body.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE)
      .json(body);
  }
}

async function timed(name: string, run: () => Promise<void>): Promise<HealthCheck> {
  const started = Date.now();
  try {
    await run();
    return { name, status: 'ok', latencyMs: Date.now() - started, detail: null };
  } catch (error) {
    return {
      name,
      status: 'fail',
      latencyMs: Date.now() - started,
      // The message, not the stack. This body is read by a developer running
      // dev-smoke and by the /status page, and a stack is neither.
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
