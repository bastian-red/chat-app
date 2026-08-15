import { defineConfig } from 'vitest/config';

// Pure helpers and the three design gates. Component behaviour is covered by the
// Playwright suite, so there is no jsdom environment here: identity.test.ts,
// contrast.test.ts and tokens.test.ts all read the real stylesheets off disk,
// which needs node and nothing else.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/**/*.test.ts', 'app/**/*.test.ts'],
    exclude: ['node_modules/**', '.next/**'],
  },
});
