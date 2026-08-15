import { defineConfig } from 'vitest/config';

// Gate lane: fast, deterministic, no network and no database.
// Integration tests live in test/ and run under vitest.integration.config.ts.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
