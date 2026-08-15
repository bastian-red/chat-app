/**
 * The configuration boundary, including the one precedence rule the second
 * gateway replica depends on.
 *
 * `loadConfig` takes its environment as a parameter for exactly this: a test that
 * wrote to `process.env` would leak into every test that ran after it in the same
 * worker, and the failure would look like an unrelated flake.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';
import { BootError, assertBootable } from './boot';

/** A complete, valid environment. Every case below is this with one field changed. */
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  APP_VERSION: '0.1.0',
  REALTIME_PORT: '4100',
  DATABASE_URL: 'postgresql://chat:chat@localhost:5438/chat?schema=public',
  REDIS_URL: 'redis://localhost:6385',
  AUTH_SECRET: 'a-secret-that-is-long-enough',
  APP_BASE_URL: 'http://localhost:3000',
  SEND_RETRY_ATTEMPTS: '5',
  HISTORY_PAGE_SIZE: '40',
  CATCHUP_MAX_MESSAGES: '200',
  PRESENCE_HEARTBEAT_SECONDS: '10',
  PRESENCE_TTL_SECONDS: '25',
  TYPING_TTL_SECONDS: '5',
  SOCKET_MAX_PAYLOAD_BYTES: '65536',
  SOCKET_EVENT_RATE_LIMIT: '240',
};

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(BASE);

    expect(config.port).toBe(4100);
    expect(config.historyPageSize).toBe(40);
    expect(config.socketEventRateLimit).toBe(240);
  });

  describe('PORT wins over REALTIME_PORT', () => {
    it('takes PORT when it is set', () => {
      // The rule the second replica runs on. `infra/docker-compose.yml`'s
      // `realtime-2` runs the image `realtime` already built and sets PORT=4101;
      // reversing this precedence would bind both replicas to 4100, kill one with
      // EADDRINUSE, and make the cross-replica proof in scripts/integration.sh
      // pass against a single process.
      expect(loadConfig({ ...BASE, PORT: '4101' }).port).toBe(4101);
    });

    it('falls through to REALTIME_PORT when PORT is empty', () => {
      // `.env.example` ships `PORT=` empty on purpose, because a host running
      // `pnpm dev` wants REALTIME_PORT and setting PORT locally would move the
      // API too.
      expect(loadConfig({ ...BASE, PORT: '' }).port).toBe(4100);
    });

    it('falls through when PORT is only whitespace', () => {
      expect(loadConfig({ ...BASE, PORT: '   ' }).port).toBe(4100);
    });

    it('refuses an empty PORT with no REALTIME_PORT rather than binding port zero', () => {
      // `z.coerce.number()` would read '' as 0, and the OS reads port 0 as "any
      // free port" -- a gateway listening somewhere nobody can find.
      expect(() => loadConfig({ ...BASE, PORT: '', REALTIME_PORT: undefined })).toThrow(
        ConfigError,
      );
    });
  });

  describe('refusals', () => {
    it('refuses a missing AUTH_SECRET', () => {
      // Not merely a broken sign-in: without it every socket handshake fails,
      // which presents as a conversation that renders and never moves.
      expect(() => loadConfig({ ...BASE, AUTH_SECRET: undefined })).toThrow(ConfigError);
    });

    it('refuses a short AUTH_SECRET, matching the other two verifiers', () => {
      expect(() => loadConfig({ ...BASE, AUTH_SECRET: 'short' })).toThrow(/16 characters/u);
    });

    it('refuses a DATABASE_URL that is not a URL', () => {
      expect(() => loadConfig({ ...BASE, DATABASE_URL: 'chat' })).toThrow(ConfigError);
    });

    it('refuses a non-numeric port', () => {
      expect(() => loadConfig({ ...BASE, REALTIME_PORT: 'four thousand' })).toThrow(ConfigError);
    });

    it('refuses a port above the range', () => {
      expect(() => loadConfig({ ...BASE, REALTIME_PORT: '70000' })).toThrow(ConfigError);
    });

    it('refuses a zero tuning value', () => {
      expect(() => loadConfig({ ...BASE, HISTORY_PAGE_SIZE: '0' })).toThrow(ConfigError);
    });

    it('lists every failing name at once', () => {
      // Starting a process five times to discover five missing variables is the
      // experience this avoids, and it is the common case on a fresh clone.
      const thrown = (): void => {
        loadConfig({ ...BASE, AUTH_SECRET: undefined, REDIS_URL: undefined });
      };

      expect(thrown).toThrow(/AUTH_SECRET/u);
      expect(thrown).toThrow(/REDIS_URL/u);
    });

    it('names the variable a reader can grep for, not the config field', () => {
      // `catchUpMaxMessages` is `CATCHUP_MAX_MESSAGES` and not
      // `CATCH_UP_MAX_MESSAGES`, so the mapping is written out rather than
      // derived by a case transform.
      expect(() => loadConfig({ ...BASE, CATCHUP_MAX_MESSAGES: 'lots' })).toThrow(
        /CATCHUP_MAX_MESSAGES/u,
      );
    });
  });

  it('defaults NODE_ENV and APP_VERSION rather than refusing to start', () => {
    // Neither changes behaviour the gateway depends on: one is a label on the
    // health response and the other is turbo's own. Refusing to boot without them
    // would make a `docker run` with no env file fail for a cosmetic reason.
    const config = loadConfig({ ...BASE, NODE_ENV: undefined, APP_VERSION: undefined });

    expect(config.nodeEnv).toBe('development');
    expect(config.appVersion).toBe('0.0.0');
  });
});

describe('assertBootable', () => {
  const config = loadConfig(BASE);

  it('accepts the shipped values', () => {
    expect(() => {
      assertBootable(config);
    }).not.toThrow();
  });

  it('refuses a presence TTL at twice the heartbeat', () => {
    expect(() => {
      assertBootable({ ...config, presenceTtlSeconds: 20 });
    }).toThrow(BootError);
  });

  it('refuses a catch-up ceiling below one page of history', () => {
    // A client that reconnects after missing one page would answer TOO_FAR_BEHIND
    // and reload, and the first thing it does after reloading is ask for the page
    // it just failed to splice.
    expect(() => {
      assertBootable({ ...config, catchUpMaxMessages: 39 });
    }).toThrow(/HISTORY_PAGE_SIZE/u);
  });

  it('accepts a catch-up ceiling at exactly one page', () => {
    expect(() => {
      assertBootable({ ...config, catchUpMaxMessages: 40 });
    }).not.toThrow();
  });

  it('refuses a frame ceiling below a maximum-length message body', () => {
    // The contract caps a body at 4000 characters, which is at most 16000 bytes
    // of UTF-8. Below that, a legal message is refused by the transport, where
    // the client gets a disconnect rather than a sentence it can show somebody.
    expect(() => {
      assertBootable({ ...config, socketMaxPayloadBytes: 8192 });
    }).toThrow(/SOCKET_MAX_PAYLOAD_BYTES/u);
  });

  it('accepts a frame ceiling at exactly that size', () => {
    expect(() => {
      assertBootable({ ...config, socketMaxPayloadBytes: 16_000 });
    }).not.toThrow();
  });
});
