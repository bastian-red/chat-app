import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';

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
 * Firefox matters here more than anywhere else in the suite: it is the engine that
 * reported a sibling project's scrollable regions as keyboard-inaccessible when
 * Chromium's axe run did not, and that was a real WCAG 2.1.1 failure. A
 * conversation is a scrollable region, so this project has the same surface.
 */
const SCHEMES = ['light', 'dark'] as const;

async function scan(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

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

    test('the landing page has no violations', async ({ page }) => {
      await page.goto('/');
      await scan(page);
    });

    test('the login page has no violations', async ({ page }) => {
      await page.goto('/login');
      await scan(page);
    });

    test('the signup page has no violations', async ({ page }) => {
      await page.goto('/signup');
      await scan(page);
    });

    test('the status page has no violations', async ({ page }) => {
      await page.goto('/status');
      await scan(page);
    });

    test('the channel list has no violations', async ({ page }) => {
      await signIn(page);
      await scan(page);
    });

    test('the conversation has no violations', async ({ page }) => {
      await signIn(page);
      await page.getByRole('link', { name: DEMO_CHANNEL }).click();
      await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
      await scan(page);
    });
  });
}
