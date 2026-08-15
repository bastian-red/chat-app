import { defineConfig } from 'vitest/config';

// Gate lane. Every function in this package runs against the in-memory
// repository in `test-repository.ts`, which is a Map and a counter -- so the
// permission matrix, the idempotency branch and the DM-key derivation are all
// covered here in milliseconds with no container. What this lane cannot prove is
// that Postgres serialises two concurrent `UPDATE ... RETURNING next_seq`
// statements; `apps/api/test/concurrency.integration.test.ts` runs the same
// functions against a real database for that.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
