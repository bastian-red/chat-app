import { defineConfig } from 'vitest/config';

// Gate lane. The roster and the typing set are pure functions over a Redis-shaped
// interface, so this lane runs them against a fake client -- a Map with an
// explicit clock -- and can therefore assert on TTL expiry without sleeping for
// it. What it cannot prove is that a real Redis expires a key on the same
// schedule; `apps/api/test/presence.integration.test.ts` runs the same code
// against a real one for that.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
