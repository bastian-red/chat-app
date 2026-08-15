/**
 * Every environment variable this process reads, parsed once, at the edge.
 *
 * Two rules hold here and nowhere else in the app:
 *
 * **`process.env` is read in this file and in no other.** A `process.env.FOO`
 * inside a handler is `undefined` on a typo, and the failure surfaces three layers
 * away as a socket that connects and never delivers. Parsed here, a missing or
 * malformed value is a refusal to start with the name in the message.
 *
 * **Every read is spelled `env.NAME` literally.** `scripts/env-contract.mjs` finds
 * the names this process needs by regex over the source and checks them against
 * `turbo.json` and `.env.example` in all four directions. A computed lookup
 * (`env[key]`) is invisible to it, and turbo 2 runs in strict env mode, so an
 * undeclared name is silently stripped rather than reported.
 *
 * ---------------------------------------------------------------------------
 * `PORT` before `REALTIME_PORT`, and why that order is load-bearing
 *
 * `PORT` is the name every container runtime injects, and it is what makes the
 * second gateway replica possible without a second image:
 * `infra/docker-compose.yml`'s `realtime-2` runs the image `realtime` already
 * built and sets `PORT=4101`. Reversing the precedence would mean both replicas
 * binding 4100, one of them dying with EADDRINUSE, and the cross-replica proof in
 * `scripts/integration.sh` passing vacuously against a single process.
 *
 * `.env.example` therefore ships `PORT` empty: a host running `pnpm dev` wants
 * `REALTIME_PORT`, and setting `PORT` locally would move the API too, which reads
 * it with the same precedence.
 */
import { z } from 'zod';

/**
 * A port from a string.
 *
 * `z.coerce.number()` would accept `''` as 0, because `Number('')` is 0 and not
 * NaN. An empty `PORT` is exactly what `.env.example` ships, so this has to treat
 * it as absent rather than as "bind port zero", which the OS reads as "any free
 * port" and which would produce a gateway listening somewhere nobody can find.
 */
const port = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().int().min(1).max(65535));

/** A positive integer setting, with the name preserved for the error message. */
const positiveInt = z
  .string()
  .trim()
  .regex(/^\d+$/u, 'must be a whole number')
  .transform(Number)
  .pipe(z.number().int().positive());

export interface RealtimeConfig {
  nodeEnv: string;
  appVersion: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  authSecret: string;
  appBaseUrl: string;
  sendRetryAttempts: number;
  historyPageSize: number;
  catchUpMaxMessages: number;
  presenceHeartbeatSeconds: number;
  presenceTtlSeconds: number;
  typingTtlSeconds: number;
  socketMaxPayloadBytes: number;
  socketEventRateLimit: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Parse the environment into a config, or refuse.
 *
 * Takes `env` as a parameter with `process.env` as the default, so the gate lane
 * can hand it a record rather than mutating the process's own environment. A test
 * that writes to `process.env` leaks into every test that runs after it in the
 * same worker.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const schema = z.object({
    nodeEnv: z.string().default('development'),
    appVersion: z.string().default('0.0.0'),
    // The precedence documented in the header is resolved below, where the input
    // object is built, rather than in the schema: an empty `PORT` has to fall
    // through to `REALTIME_PORT`, and a schema that treated `''` as a value would
    // have to encode "absent" twice.
    port,
    databaseUrl: z.string().url(),
    redisUrl: z.string().url(),
    // 16 characters, matching apps/api and apps/web. Three processes verify the
    // same HS256 signature, so a secret one of them considers too short is a
    // handshake that fails for a reason none of them reports.
    authSecret: z.string().min(16, 'AUTH_SECRET must be at least 16 characters'),
    appBaseUrl: z.string().url(),
    sendRetryAttempts: positiveInt,
    historyPageSize: positiveInt,
    catchUpMaxMessages: positiveInt,
    presenceHeartbeatSeconds: positiveInt,
    presenceTtlSeconds: positiveInt,
    typingTtlSeconds: positiveInt,
    socketMaxPayloadBytes: positiveInt,
    socketEventRateLimit: positiveInt,
  });

  const parsed = schema.safeParse({
    nodeEnv: env.NODE_ENV,
    appVersion: env.APP_VERSION,
    port: env.PORT !== undefined && env.PORT.trim() !== '' ? env.PORT : env.REALTIME_PORT,
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    authSecret: env.AUTH_SECRET,
    appBaseUrl: env.APP_BASE_URL,
    sendRetryAttempts: env.SEND_RETRY_ATTEMPTS,
    historyPageSize: env.HISTORY_PAGE_SIZE,
    catchUpMaxMessages: env.CATCHUP_MAX_MESSAGES,
    presenceHeartbeatSeconds: env.PRESENCE_HEARTBEAT_SECONDS,
    presenceTtlSeconds: env.PRESENCE_TTL_SECONDS,
    typingTtlSeconds: env.TYPING_TTL_SECONDS,
    socketMaxPayloadBytes: env.SOCKET_MAX_PAYLOAD_BYTES,
    socketEventRateLimit: env.SOCKET_EVENT_RATE_LIMIT,
  });

  if (!parsed.success) {
    // Every failing name in one message, not the first one. Starting a process
    // five times to discover five missing variables is the experience this
    // avoids, and it is the common case on a fresh clone.
    const lines = parsed.error.issues.map(
      (issue) => `  ${ENV_NAMES[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`,
    );
    throw new ConfigError(`Cannot start the gateway. Fix these in .env:\n${lines.join('\n')}`);
  }

  return parsed.data as RealtimeConfig;
}

/**
 * Config key back to the variable name a reader can grep for.
 *
 * Written out per key rather than derived by a case transform: `catchUpMaxMessages`
 * is `CATCHUP_MAX_MESSAGES` and not `CATCH_UP_MAX_MESSAGES`, and a message naming
 * a variable that does not exist is worse than one naming the field.
 */
const ENV_NAMES: Record<string, string> = {
  nodeEnv: 'NODE_ENV',
  appVersion: 'APP_VERSION',
  port: 'PORT / REALTIME_PORT',
  databaseUrl: 'DATABASE_URL',
  redisUrl: 'REDIS_URL',
  authSecret: 'AUTH_SECRET',
  appBaseUrl: 'APP_BASE_URL',
  sendRetryAttempts: 'SEND_RETRY_ATTEMPTS',
  historyPageSize: 'HISTORY_PAGE_SIZE',
  catchUpMaxMessages: 'CATCHUP_MAX_MESSAGES',
  presenceHeartbeatSeconds: 'PRESENCE_HEARTBEAT_SECONDS',
  presenceTtlSeconds: 'PRESENCE_TTL_SECONDS',
  typingTtlSeconds: 'TYPING_TTL_SECONDS',
  socketMaxPayloadBytes: 'SOCKET_MAX_PAYLOAD_BYTES',
  socketEventRateLimit: 'SOCKET_EVENT_RATE_LIMIT',
};
