/**
 * The application graph.
 *
 * Two global bindings, both chosen so the unsafe direction is the one that needs
 * a decision:
 *
 * - **`SessionGuard` is global.** A route added next year is authenticated
 *   unless somebody writes `@Public()` on it. The opposite arrangement -- a guard
 *   applied per controller -- fails silently in the direction that matters,
 *   because a forgotten decorator is an open endpoint and nothing about the code
 *   looks wrong.
 * - **`ThrottlerGuard` is global**, so the general budget applies everywhere and
 *   `@Throttle({ auth: {} })` narrows it on the two auth routes rather than
 *   widening it.
 *
 * The throttler's storage is Redis rather than the default in-memory one, because
 * a limit that resets when a process restarts, and that counts separately on each
 * replica, is not a limit.
 */
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';

import { API_CONFIG, type ApiConfig } from './config/config';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ChannelsController } from './channels/channels.controller';
import { ChannelsService } from './channels/channels.service';
import { DomainErrorFilter } from './common/domain-error.filter';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { RedisService } from './infra/redis.service';
import { SessionGuard } from './common/session.guard';
import { UploadsController } from './uploads/uploads.controller';
import { UploadsService } from './uploads/uploads.service';

@Module({
  imports: [
    InfraModule,
    ThrottlerModule.forRootAsync({
      inject: [API_CONFIG, RedisService],
      useFactory: (config: ApiConfig, redis: RedisService) => ({
        throttlers: [
          // The general budget, per client address, per minute.
          { name: 'default', ttl: 60_000, limit: config.rateLimitGlobal },
          // Auth is the credential-stuffing surface, so its budget is an order of
          // magnitude below the general one. Named, so `@Throttle({ auth: {} })`
          // on register and sign-in selects it.
          { name: 'auth', ttl: 60_000, limit: config.rateLimitAuth },
        ],
        // The same connection the broadcast emitter uses. A second one would be a
        // second thing to fail and a second error listener to forget.
        storage: new ThrottlerStorageRedisService(redis.client),
      }),
    }),
  ],
  controllers: [AuthController, ChannelsController, UploadsController, HealthController],
  providers: [
    AuthService,
    ChannelsService,
    UploadsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_FILTER, useClass: DomainErrorFilter },
  ],
})
export class AppModule {}
