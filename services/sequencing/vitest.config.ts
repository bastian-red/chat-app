import { defineConfig } from 'vitest/config';

// Gate lane, and the heaviest suite in it: the property tests run tens of
// thousands of interleaved inserts. Still pure, still offline, still well under
// two seconds, because none of it touches I/O.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
