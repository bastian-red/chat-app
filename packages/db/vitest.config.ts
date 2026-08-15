import { defineConfig } from 'vitest/config';

// Gate lane. Only the error-classification helpers are unit tested here: they are
// pure functions over an error shape and need no database. The constraints
// themselves are exercised by the integration lane, which has one.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
