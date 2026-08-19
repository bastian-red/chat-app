import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';

import { DEMO_CHANNEL, expect, signIn, test } from '../fixtures';

/**
 * axe over every route, in both colour schemes, with zero violations and no rule
 * exclusions.
 *
 * **Both schemes, because the palette is different in each.** A contrast failure
 * that only exists in dark mode is invisible to a suite that runs in light, and
 * this project's dark palette is an override subset rather than a copy, so the two
 * genuinely differ.
 *
 * **No `disableRules`.** An excluded rule is a violation somebody decided not to
 * see, and the exclusion outlives the reason for it. If a rule fires, the markup
 * changes.
 *
 * ---------------------------------------------------------------------------
 * Two modes, and the second one is why `scripts/a11y-baseline.sh` exists
 *
 * Normally every run asserts zero violations and fails otherwise.
 *
 * Under `BASELINE=1` it **records instead of failing**. That inversion is the
 * whole point of a baseline: it is wanted at exactly the moment the app is
 * failing, before a redesign, and a recorder that refused to run while there were
 * violations could never capture the number anybody wanted. `scripts/a11y-summary.mjs`
 * reads the attachment this writes, so the shape below is a contract with that
 * script rather than a convenience.
 *
 * Firefox matters here more than anywhere else in the suite: it is the engine that
 * reported a sibling project's scrollable regions as keyboard-inaccessible when
 * Chromium's axe run did not, and that was a real WCAG 2.1.1 failure. A
 * conversation is a scrollable region, so this project has the same surface -- and
 * when that fired here it fired in both engines.
 */
const SCHEMES = ['light', 'dark'] as const;

/** Record rather than assert. See the header: a baseline is wanted while red. */
const RECORDING = process.env.BASELINE === '1';

async function scan(page: Page, testInfo: TestInfo, route: string, scheme: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  if (RECORDING) {
    // The shape `scripts/a11y-summary.mjs` parses. Route and scheme travel in the
    // payload rather than being recovered from the test title, because a title is
    // prose and gets rewritten.
    await testInfo.attach('a11y', {
      contentType: 'application/json',
      body: JSON.stringify({ route, scheme, violations: results.violations }),
    });
    return;
  }

  // The violation list itself, not a count. A failure that says "expected 0, got
  // 2" costs a debugging session that the rule ids and the failing nodes would
  // have saved.
  expect(
    results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target.join(' ')),
    })),
  ).toEqual([]);
}

for (const scheme of SCHEMES) {
  test.describe(`${scheme} scheme`, () => {
    test.use({ colorScheme: scheme });

    test('the landing page has no violations', async ({ page }, testInfo) => {
      await page.goto('/');
      await scan(page, testInfo, '/', scheme);
    });

    test('the login page has no violations', async ({ page }, testInfo) => {
      await page.goto('/login');
      await scan(page, testInfo, '/login', scheme);
    });

    test('the signup page has no violations', async ({ page }, testInfo) => {
      await page.goto('/signup');
      await scan(page, testInfo, '/signup', scheme);
    });

    test('the status page has no violations', async ({ page }, testInfo) => {
      await page.goto('/status');
      await scan(page, testInfo, '/status', scheme);
    });

    test('the channel list has no violations', async ({ page }, testInfo) => {
      await signIn(page);
      await scan(page, testInfo, '/channels', scheme);
    });

    test('the conversation has no violations', async ({ page }, testInfo) => {
      await signIn(page);
      await page.getByRole('link', { name: DEMO_CHANNEL }).click();
      await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
      await scan(page, testInfo, '/channels/:id', scheme);
    });
  });
}
