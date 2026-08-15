/**
 * The three things every feature module needs: the config, Postgres, Redis.
 *
 * `@Global()`, which this codebase otherwise avoids. The justification is narrow
 * and worth stating: these are process-level singletons with a lifecycle, and the
 * alternative is importing this module into all five feature modules, where a
 * forgotten import is a runtime injection error rather than a compile error. A
 * global module for connections is a different thing from a global module for
 * business logic, and nothing with business logic goes in here.
 *
 * `MESSAGING_REPOSITORY` is the Prisma adapter from `@chat/db`, bound
 * to the `MessagingRepository` port. Every write in this process goes through it,
 * so the API has exactly one write path and it is the same one the gateway uses.
 */
import { PrismaMessagingRepository } from '@chat/db';
import { Global, Module } from '@nestjs/common';
import type { MessagingRepository } from '@chat/messaging';

import { API_CONFIG, loadConfig, type ApiConfig } from '../config/config';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';

export const MESSAGING_REPOSITORY = 'MESSAGING_REPOSITORY';

@Global()
@Module({
  providers: [
    {
      provide: API_CONFIG,
      // Parsed once here. `main.ts` calls `loadConfig()` too, before the
      // application exists, so a bad environment fails with a plain sentence
      // rather than a Nest bootstrap stack; both calls are pure and produce the
      // same object.
      useFactory: (): ApiConfig => loadConfig(),
    },
    PrismaService,
    RedisService,
    {
      provide: MESSAGING_REPOSITORY,
      useFactory: (prisma: PrismaService): MessagingRepository =>
        new PrismaMessagingRepository(prisma),
      inject: [PrismaService],
    },
  ],
  exports: [API_CONFIG, PrismaService, RedisService, MESSAGING_REPOSITORY],
})
export class InfraModule {}
