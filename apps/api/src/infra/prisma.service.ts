/**
 * The Prisma client, as a Nest provider with a real lifecycle.
 *
 * `onModuleInit` connects **eagerly**. Prisma's default is to connect on the
 * first query, which turns "the database is unreachable" into an error on
 * whichever request happened to arrive first: a user-facing 500 for an
 * operational fact that was true before the process started. Connecting at boot
 * means the process fails to start instead, with the connection string's host in
 * the message.
 *
 * `onModuleDestroy` disconnects, so a `SIGTERM` during a rolling restart returns
 * the pool rather than leaving Postgres to time the connections out.
 */
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { PrismaClient } from '@chat/db';

import { API_CONFIG, type ApiConfig } from '../config/config';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  // A plain constructor parameter, not `import type`. `emitDecoratorMetadata`
  // writes the constructor's parameter types at compile time and Nest resolves
  // dependencies from them; an `import type` erases the class, the metadata
  // records `undefined`, and injection fails at runtime with an error pointing
  // nowhere near the import. See `docs/CODESTYLE.md` section 6.
  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    super({ datasources: { db: { url: config.databaseUrl } } });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
