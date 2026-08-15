/**
 * The API's entry point.
 *
 * `loadConfig()` and `assertBootable()` run **before** `NestFactory.create`, and
 * that order is the point. A Nest bootstrap failure is a stack trace with the one
 * useful line somewhere in the middle; a config failure here is a sentence naming
 * the variables to fix. The same values are parsed again inside the module graph,
 * which is free: `loadConfig` is pure.
 */
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { assertBootable } from './config/boot';
import { loadConfig } from './config/config';

async function main(): Promise<void> {
  const config = loadConfig();
  await assertBootable(config);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Nest's own logger, minus `log` and `verbose`. The API is not the place for
    // a line per request; that is the reverse proxy's job, and in development it
    // is noise that hides the one warning that matters.
    logger: ['error', 'warn'],
    // The body parser is left on for JSON but the upload route reads the raw
    // request stream, so nothing may buffer a multipart body before it.
    bodyParser: true,
  });

  // The throttler keys on the client address. Without this, every request behind
  // a proxy carries the proxy's address and one budget is shared by everybody,
  // which turns a per-client limit into a global outage the first time anybody
  // hits it. `1` and not `true`: trusting every hop means trusting a header the
  // client can set.
  app.set('trust proxy', 1);

  app.enableCors({ origin: config.appBaseUrl, credentials: true });

  // Nest's default is to keep the process alive on SIGTERM. Enabling this is what
  // makes `PrismaService.onModuleDestroy` and `RedisService.onModuleDestroy` run,
  // so a rolling restart returns its connections instead of leaving Postgres to
  // time them out.
  app.enableShutdownHooks();

  await app.listen(config.port);
  console.warn(`[api] listening on :${String(config.port)}`);
}

main().catch((error: unknown) => {
  // The message alone. `ConfigError` and `BootError` are written to be read by
  // whoever is starting the process, and a stack in front of "fix these in .env"
  // buries the one line that matters.
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
