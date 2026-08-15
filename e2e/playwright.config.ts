import { defineConfig, devices } from '@playwright/test';

/**
 * The E2E lane.
 *
 * **There is no `webServer` block, deliberately.** `scripts/e2e.sh` owns the
 * lifecycle: it migrates, builds in production mode, reseeds, and starts all
 * three processes -- api, realtime gateway and web -- before Playwright is
 * invoked. Letting this config start them instead would mean two different ways
 * to bring the stack up, one of them missing the reseed, and the suite would then
 * pass or fail depending on which one a developer happened to use. Run the lane
 * with `./scripts/e2e.sh`, never with `playwright test` alone.
 *
 * **Two browsers, not one.** Chromium and Firefox. Firefox is not redundancy: it
 * is the engine that reported a sibling project's scrollable regions as
 * keyboard-inaccessible when Chromium's axe run did not, and that was a real WCAG
 * 2.1.1 failure. A conversation is a scrollable region, so this project has the
 * same shape of surface. The specs also lean on a WebSocket that has to survive a
 * reload and on `prefers-color-scheme` emulation, and those are exactly where two
 * engines disagree. Nothing here is WebKit-specific enough to justify a third
 * install on every CI run.
 *
 * **Workers are 1.** Every spec drives the same seeded channels, and this suite
 * opens *two browser contexts at once* to prove a cross-client broadcast: a second
 * worker sending into a channel while another asserts on its message list is a
 * flake that reproduces once a fortnight. The suite is small enough that serial
 * execution costs less than the debugging would.
 *
 * `timezoneId: 'UTC'` is pinned for a reason specific to this app: the
 * conversation draws its day dividers from the reader's *stored* zone, not from
 * the browser's. A spec that passed only because the browser agreed with the
 * database would be testing nothing.
 */
const WEB_PORT = process.env.WEB_PORT ?? '3000';
const API_PORT = process.env.API_PORT ?? '4000';
const REALTIME_PORT = process.env.REALTIME_PORT ?? '4100';

export default defineConfig({
  testDir: './tests',
  // `demo.spec.ts` is a capture, not a check: it writes PNGs into
  // `e2e/demo-shots/` and holds still for animations, neither of which belongs in
  // the lane that runs on every push. `scripts/demo-gif.sh` sets DEMO=1 to turn it
  // on. Nothing else in the suite is ever skipped.
  testIgnore: process.env.DEMO === '1' ? [] : ['**/demo.spec.ts'],
  // Failing the run on a stray `test.only` that reached a branch, rather than
  // silently running one test and reporting green.
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  workers: 1,
  // One retry on CI and none locally. A retry hides a flake locally, where it
  // should be fixed; on a shared runner it absorbs cold-start jitter that has
  // nothing to do with the code, and the trace from the first attempt is still
  // attached.
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['json']]
    : [['list'], ['html', { open: 'never' }], ['json']],
  outputDir: './test-results',

  use: {
    baseURL: process.env.APP_BASE_URL ?? `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'en-US',
    timezoneId: 'UTC',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
  ],
});

/** Where the API lives, for specs using the `request` fixture directly. */
export const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${API_PORT}`;

/**
 * The first gateway. `health.spec.ts` probes it directly rather than through the
 * web app, because a `/status` page that renders "everything is fine" while the
 * gateway is refusing connections is the failure that page exists to catch, and a
 * spec that only reads the page cannot tell the two apart.
 */
export const realtimeBaseUrl = process.env.REALTIME_BASE_URL ?? `http://localhost:${REALTIME_PORT}`;

/**
 * The second gateway, when `scripts/e2e.sh` started one.
 *
 * Undefined means "not running", not "running on the default port": asserting
 * against a hardcoded 4101 that nothing is listening on would report a stack
 * problem for a lane that deliberately runs one replica.
 */
export const realtimeBaseUrl2 = process.env.REALTIME_BASE_URL_2;
