import { DEMO_CHANNEL, asSecondPerson, expect, openDemoChannel, signIn, test } from '../fixtures';

/**
 * The frames `scripts/demo-gif.sh` stitches into the README's GIF.
 *
 * A capture, not a check. It writes PNGs and holds still for animations, neither
 * of which belongs in the lane that runs on every push, so
 * `playwright.config.ts` ignores this file unless `DEMO=1` is set.
 *
 * The shots are taken from **two contexts side by side**, because the thing worth
 * showing is the one thing a screenshot of a single window cannot: a message
 * crossing from one person to another with no reload.
 */
test.describe('demo capture', () => {
  test('two people, one conversation', async ({ page, browser }) => {
    await page.setViewportSize({ width: 900, height: 720 });
    await signIn(page);
    await openDemoChannel(page);
    await page.screenshot({ path: 'demo-shots/01-conversation.png' });

    const other = await browser.newContext({ viewport: { width: 900, height: 720 } });
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);

    // The typing indicator, held long enough to be a frame rather than a blur.
    await theirs.getByRole('textbox', { name: 'Message' }).fill('Reviewing the allocator now');
    await expect(page.getByRole('status').filter({ hasText: /typing/ })).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({ path: 'demo-shots/02-typing.png' });

    await theirs.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText('Reviewing the allocator now')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: 'demo-shots/03-received.png' });
    await theirs.screenshot({ path: 'demo-shots/04-sender.png' });

    await page.goto('/channels');
    await expect(page.getByRole('link', { name: DEMO_CHANNEL })).toBeVisible();
    await page.screenshot({ path: 'demo-shots/05-sidebar.png' });

    await page.goto('/status');
    await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();
    await page.screenshot({ path: 'demo-shots/06-status.png' });

    await other.close();
  });
});
