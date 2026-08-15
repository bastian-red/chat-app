/**
 * What every spec needs: the seeded facts, a signed-in page, and a second person.
 *
 * The seeded values are **read out of `packages/db/prisma/seed.ts`** rather than
 * retyped. A copy that drifts produces a spec confidently asserting on data that
 * no longer exists, which fails as a product bug and is a test bug. The seed
 * declares them as one-line constants for exactly this, and `scripts/seed-check.sh`
 * and `scripts/dev-smoke.sh` read them the same way.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test as base, type BrowserContext, type Page } from '@playwright/test';

const SEED = readFileSync(join(__dirname, '..', 'packages', 'db', 'prisma', 'seed.ts'), 'utf8');

function seedConst(name: string): string {
  const match = new RegExp(`^const ${name} = '([^']*)';`, 'm').exec(SEED);
  if (!match) throw new Error(`Could not read ${name} out of packages/db/prisma/seed.ts.`);
  return match[1]!;
}

export const DEMO_EMAIL = seedConst('DEMO_EMAIL');
export const DEMO_PASSWORD = seedConst('DEMO_PASSWORD');
export const DEMO_CHANNEL = seedConst('DEMO_CHANNEL');
export const DEMO_MESSAGE = seedConst('DEMO_MESSAGE');

/** The second seeded account, for the two-context specs. */
export const SECOND_EMAIL = 'bruno@chat.test';
export const SECOND_NAME = 'Bruno Salas';

/**
 * Sign in through the real form.
 *
 * Not by setting a cookie. The form is the path a person takes and the one that
 * exercises Auth.js, the credentials provider and the API's sign-in route; a
 * fixture that forged a session would skip all three and would keep passing after
 * any of them broke.
 *
 * Located by **role and accessible name**, never by CSS class or test id. That is
 * only possible because every control in this app has a real label, and holding
 * the specs to it is what keeps that true: a field whose label disappears breaks
 * a spec rather than quietly becoming unreachable to a screen reader.
 */
export async function signIn(page: Page, email = DEMO_EMAIL, password = DEMO_PASSWORD) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
}

/** Open the seeded channel and wait for the conversation to be live. */
export async function openDemoChannel(page: Page) {
  await page.goto('/channels');
  await page.getByRole('link', { name: DEMO_CHANNEL }).click();
  await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
  // The socket, not the render. Everything a spec does after this depends on the
  // gateway having accepted the handshake, and waiting for the text rather than
  // the connection would race every assertion after it.
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 15_000 });
}

/**
 * A second signed-in person, in their own **context**.
 *
 * A context, not a second page. Two pages in one context share a cookie jar, so
 * they are one session and one person, and a spec that used them would prove that
 * a browser can render the same conversation twice rather than that two people
 * see each other's messages.
 */
export async function asSecondPerson(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await signIn(page, SECOND_EMAIL, DEMO_PASSWORD);
  return page;
}

export const test = base;
export { expect };
