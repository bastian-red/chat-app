/**
 * Every environment variable the API reads, parsed once, at the edge.
 *
 * Not `@nestjs/config`. That module makes `configService.get('FOO')` available
 * everywhere, which is the problem: a typo is `undefined` at a call site three
 * layers from the boot, and the failure arrives as a request that 500s rather than
 * as a process that refused to start. One typed object, built here, injected as a
 * value.
 *
 * **Every read is spelled `env.NAME` literally.** `scripts/env-contract.mjs` finds
 * the names this process needs by regex over the source and checks them against
 * `turbo.json` and `.env.example` in all four directions. A computed lookup is
 * invisible to it, and turbo 2 runs in strict env mode, so an undeclared name is
 * silently stripped rather than reported.
 *
 * `PORT` before `API_PORT`, matching `apps/realtime/src/config.ts` and matching
 * what every container runtime injects. `.env.example` ships `PORT` empty because
 * a host running `pnpm dev` wants the two services on different ports.
 */
import { z } from 'zod';

const port = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

const positiveInt = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().int().positive());

export interface ApiConfig {
  nodeEnv: string;
  appVersion: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  appBaseUrl: string;
  sendRetryAttempts: number;
  historyPageSize: number;
  presenceTtlSeconds: number;
  uploadDir: string;
  uploadMaxBytes: number;
  rateLimitGlobal: number;
  rateLimitAuth: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Config key back to the variable name a reader can grep for. Written out per key. */
const ENV_NAMES: Record<string, string> = {
  nodeEnv: 'NODE_ENV',
  appVersion: 'APP_VERSION',
  port: 'PORT / API_PORT',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  authSecret: 'AUTH_SECRET',
  appBaseUrl: 'APP_BASE_URL',
  sendRetryAttempts: 'SEND_RETRY_ATTEMPTS',
  historyPageSize: 'HISTORY_PAGE_SIZE',
  presenceTtlSeconds: 'PRESENCE_TTL_SECONDS',
  uploadDir: 'UPLOAD_DIR',
  uploadMaxBytes: 'UPLOAD_MAX_BYTES',
  rateLimitGlobal: 'RATE_LIMIT_GLOBAL',
  rateLimitAuth: 'RATE_LIMIT_AUTH',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const schema = z.object({
    nodeEnv: z.string().default('development'),
    appVersion: z.string().default('0.0.0'),
    port,
    databaseUrl: z.string().url(),
    redisUrl: z.string().url(),
    authSecret: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
    appBaseUrl: z.string().url(),
    sendRetryAttempts: positiveInt,
    historyPageSize: positiveInt,
    // Read here as well as in the gateway, and read rather than hardcoded. The
    // gateway *maintains* the roster; this process only reads it, to paint a
    // member list on a REST response. Two processes applying two different TTLs
    // to one Redis hash would disagree about who is online, and the disagreement
    // would show as a dot that changes when the page reloads.
    presenceTtlSeconds: positiveInt,
    // A path, relative or absolute. Not validated as existing here: creating it
    // is `assertBootable`'s job, and a schema that only checked for existence
    // would reject a fresh clone that has not made `var/` yet.
    uploadDir: z.string().min(1),
    uploadMaxBytes: positiveInt,
    rateLimitGlobal: positiveInt,
    rateLimitAuth: positiveInt,
  });

  const parsed = schema.safeParse({
    nodeEnv: env.NODE_ENV,
    appVersion: env.APP_VERSION,
    port: env.PORT !== undefined && env.PORT.trim() !== '' ? env.PORT : env.API_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    authSecret: env.AUTH_SECRET,
    appBaseUrl: env.APP_BASE_URL,
    sendRetryAttempts: env.SEND_RETRY_ATTEMPTS,
    historyPageSize: env.HISTORY_PAGE_SIZE,
    presenceTtlSeconds: env.PRESENCE_TTL_SECONDS,
    uploadDir: env.UPLOAD_DIR,
    uploadMaxBytes: env.UPLOAD_MAX_BYTES,
    rateLimitGlobal: env.RATE_LIMIT_GLOBAL,
    rateLimitAuth: env.RATE_LIMIT_AUTH,
  });

  if (!parsed.success) {
    // Every failing name in one message. Starting a process five times to
    // discover five missing variables is the common experience on a fresh clone
    // and the one this avoids.
    const lines = parsed.error.issues.map(
      (issue) => `  ${ENV_NAMES[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Cannot start the API. Fix these in .env:\n${lines.join('\n')}`);
  }

  return parsed.data;
}

/** The injection token. A value provider, so nothing can construct a second config. */
export const API_CONFIG = 'API_CONFIG';
