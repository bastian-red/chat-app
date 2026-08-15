/**
 * The API's configuration boundary.
 *
 * `loadConfig` takes its environment as a parameter so no test ever writes to
 * `process.env`, which would leak into every test that ran after it in the same
 * worker and surface as an unrelated flake.
 */
import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config';
import { BootError, assertConsistent, uploadRoot } from './boot';

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  APP_VERSION: '0.1.0',
  API_PORT: '4000',
  DATABASE_URL: 'postgresql://chat:chat@localhost:5438/chat?schema=public',
  REDIS_URL: 'redis://localhost:6385',
  AUTH_SECRET: 'a-secret-that-is-long-enough',
  APP_BASE_URL: 'http://localhost:3000',
  SEND_RETRY_ATTEMPTS: '5',
  HISTORY_PAGE_SIZE: '40',
  PRESENCE_TTL_SECONDS: '25',
  UPLOAD_DIR: 'var/uploads',
  UPLOAD_MAX_BYTES: '10485760',
  RATE_LIMIT_GLOBAL: '240',
  RATE_LIMIT_AUTH: '5',
};

describe('loadConfig', () => {
  it('parses a complete environment', () => {
    const config = loadConfig(BASE);

    expect(config.port).toBe(4000);
    expect(config.uploadMaxBytes).toBe(10_485_760);
    expect(config.rateLimitAuth).toBe(5);
  });

  describe('PORT wins over API_PORT', () => {
    it('takes PORT when it is set', () => {
      // The name every container runtime injects, and the same precedence
      // `apps/realtime/src/config.ts` uses. Two services disagreeing about which
      // name wins is how one of them ends up on the other's port.
      expect(loadConfig({ ...BASE, PORT: '8080' }).port).toBe(8080);
    });

    it('falls through to API_PORT when PORT is empty', () => {
      // `.env.example` ships `PORT=` empty, because a host running `pnpm dev`
      // needs the API and the gateway on different ports.
      expect(loadConfig({ ...BASE, PORT: '' }).port).toBe(4000);
    });

    it('refuses an empty PORT with no API_PORT rather than binding port zero', () => {
      // `z.coerce.number()` reads '' as 0, and the OS reads port 0 as "any free
      // port": an API listening somewhere nobody can find.
      expect(() => loadConfig({ ...BASE, PORT: '', API_PORT: undefined })).toThrow(ConfigError);
    });
  });

  it('refuses a missing AUTH_SECRET', () => {
    // Not merely a broken sign-in. The same secret verifies every socket
    // handshake, so a missing one presents as a conversation that renders and
    // never moves.
    expect(() => loadConfig({ ...BASE, AUTH_SECRET: undefined })).toThrow(/AUTH_SECRET/u);
  });

  it('refuses a short AUTH_SECRET, matching the other two verifiers', () => {
    expect(() => loadConfig({ ...BASE, AUTH_SECRET: 'short' })).toThrow(/16 characters/u);
  });

  it('refuses a non-numeric limit', () => {
    expect(() => loadConfig({ ...BASE, RATE_LIMIT_GLOBAL: 'lots' })).toThrow(ConfigError);
  });

  it('lists every failing name at once', () => {
    const thrown = (): void => {
      loadConfig({ ...BASE, AUTH_SECRET: undefined, UPLOAD_DIR: undefined });
    };

    expect(thrown).toThrow(/AUTH_SECRET/u);
    expect(thrown).toThrow(/UPLOAD_DIR/u);
  });

  it('does not check that UPLOAD_DIR exists', () => {
    // Deliberate. Creating it is `assertUploadsWritable`'s job, and a schema that
    // required it to exist would reject a fresh clone that has not made `var/`
    // yet, which is every clone.
    expect(() => loadConfig({ ...BASE, UPLOAD_DIR: 'nowhere/at/all' })).not.toThrow();
  });
});

describe('assertConsistent', () => {
  const config = loadConfig(BASE);

  it('accepts the shipped values', () => {
    expect(() => {
      assertConsistent(config);
    }).not.toThrow();
  });

  it('refuses an auth budget at or above the global one', () => {
    // Auth is the credential-stuffing surface. A budget at or above the general
    // one is almost certainly a copy-paste, and it is the exact mistake that
    // turns a rate limit into decoration.
    expect(() => {
      assertConsistent({ ...config, rateLimitAuth: 240 });
    }).toThrow(BootError);
  });

  it('refuses an upload ceiling no real file could fit under', () => {
    expect(() => {
      assertConsistent({ ...config, uploadMaxBytes: 512 });
    }).toThrow(/UPLOAD_MAX_BYTES/u);
  });
});

describe('uploadRoot', () => {
  it('resolves a relative UPLOAD_DIR against the working directory', () => {
    // `.env.example` ships `var/uploads`, which is relative on purpose: an
    // absolute path in a committed example file would be somebody's machine.
    expect(uploadRoot(loadConfig(BASE))).toBe(`${process.cwd()}/var/uploads`);
  });

  it('leaves an absolute UPLOAD_DIR alone', () => {
    expect(uploadRoot(loadConfig({ ...BASE, UPLOAD_DIR: '/srv/chat/uploads' }))).toBe(
      '/srv/chat/uploads',
    );
  });
});
