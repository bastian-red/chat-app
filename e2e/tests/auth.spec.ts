import { DEMO_EMAIL, DEMO_PASSWORD, expect, signIn, test } from '../fixtures';

/**
 * Sign in, sign out, and the two refusals.
 *
 * Everything here goes through the real form, because the form is the path a
 * person takes: Auth.js, the credentials provider and the API's `/auth/sign-in`
 * all sit behind it, and a spec that forged a cookie would skip all three.
 */
test.describe('auth', () => {
  test('signs in and lands on the channel list', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('heading', { name: 'Channels' })).toBeVisible();
  });

  test('refuses a wrong password without saying which half was wrong', async ({ page }) => {
    // "No such account" and "wrong password" are the same answer to anybody who
    // is not the account holder. The API equalises the timing of the two for the
    // same reason; a friendlier message here would undo it at the last step.
    await page.goto('/login');
    await page.getByLabel('Email').fill(DEMO_EMAIL);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Located by its text, not by `getByRole('alert')`. Next mounts its own
    // route announcer as a second `role="alert"` on every page, so the role alone
    // is ambiguous in strict mode and the failure reads as a missing message
    // rather than as two matches.
    await expect(page.getByText('That email and password do not match an account.')).toBeVisible();
  });

  test('gives an unknown address the same answer', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody@chat.test');
    await page.getByLabel('Password').fill(DEMO_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('That email and password do not match an account.')).toBeVisible();
  });

  test('sends a signed-out reader to the login page', async ({ page }) => {
    // The browser-side boundary. The data boundary is the API's own token check,
    // so a reader who skipped this redirect would still get a 401 rather than
    // somebody else's messages.
    await page.goto('/channels');

    await expect(page).toHaveURL(/\/login/);
  });

  test('signs out', async ({ page }) => {
    await signIn(page);

    await page.getByRole('button', { name: /Sign out/ }).click();

    await expect(page).toHaveURL(/\/login/);
  });
});
