import { defineConfig } from 'vitest/config';

// Gate lane: these are pure functions and schemas, so the whole suite is
// deterministic, offline, and finishes in well under a second.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
