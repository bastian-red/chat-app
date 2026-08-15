import { DEMO_CHANNEL, DEMO_MESSAGE, expect, openDemoChannel, signIn, test } from '../fixtures';

/**
 * Sending, and the four states a message can be in on screen.
 *
 * The event names come from `@chat/shared`, never typed as literals:
 * `eslint.config.mjs` fails a hand-written event-name string anywhere in `e2e/**`,
 * because a spec waiting for a renamed event does not fail, it hangs until the
 * timeout and then reports "the message never arrived" -- a sentence about the
 * product and a lie about the cause.
 */
test.describe('messaging', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await openDemoChannel(page);
  });

  test('renders the seeded conversation with the newest page first', async ({ page }) => {
    // The seeded landmark message is written last on purpose: history is read
    // newest-first at HISTORY_PAGE_SIZE, so a message written first would sit at
    // seq 1 and fall off the page a freshly opened channel shows.
    await expect(page.getByText(DEMO_MESSAGE)).toBeVisible();
  });

  test('sends a message and replaces the optimistic line rather than doubling it', async ({
    page,
  }) => {
    const body = `sent from a spec ${String(Date.now())}`;

    await page.getByRole('textbox', { name: 'Message' }).fill(body);
    await page.getByRole('button', { name: 'Send' }).click();

    // Exactly one. The whole point of the `clientMessageId` reconciliation is
    // that the optimistic line becomes the stored one instead of sitting beside
    // it, and a doubled line is the failure that looks like a rendering bug.
    await expect(page.getByText(body)).toHaveCount(1);
    // And it stops saying "Sending" once the ack lands.
    await expect(page.getByText(body).locator('..').getByText('Sending')).toHaveCount(0);
  });

  test('clears the composer after a send', async ({ page }) => {
    await page.getByRole('textbox', { name: 'Message' }).fill('cleared afterwards');
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  test('will not send an empty message', async ({ page }) => {
    // Disabled rather than sent-and-refused. A body of 4000 spaces is empty, and
    // the schema trims before it measures, so an empty send would be a round trip
    // whose only outcome is an error nobody needed to see.
    await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('renders a tombstone as a sentence, not as a missing line', async ({ page }) => {
    // The seed soft-deletes one message. The row keeps its seq and loses its
    // body: a hole in the sequence is indistinguishable from a message this
    // client has not received, which would put every reader into a permanent
    // catch-up loop.
    await expect(page.getByText('This message was deleted')).toBeVisible();
  });

  test('says "edited" in a word rather than a tint', async ({ page }) => {
    // Same rule as presence. State is never carried by colour alone, because two
    // hues a reader cannot separate are one hue.
    await expect(page.getByText('edited').first()).toBeVisible();
  });

  test('draws a day divider from the reader’s stored zone', async ({ page }) => {
    // The seed pushes the two oldest messages onto the previous day, so the
    // conversation has exactly one divider. The browser is pinned to UTC in
    // `playwright.config.ts` and Ana's stored zone is Europe/Madrid, so a divider
    // that came from the browser rather than the stored zone would be in the
    // wrong place -- which is the point of pinning it.
    await expect(page.getByText(/\d{1,2} \w{3} \d{4}/).first()).toBeVisible();
  });

  test('shows the channel roster with a word beside every dot', async ({ page }) => {
    const roster = page.getByRole('list', { name: 'Members' });

    await expect(roster).toBeVisible();
    // A word, not a colour. Light-mode `online` and `offline` differ by a
    // contrast ratio of 1.00 -- the same pixel on a greyscale display.
    await expect(roster.getByText(/Online|Away|Offline/).first()).toBeVisible();
  });

  test('the composer is reachable and usable from the keyboard alone', async ({ page }) => {
    // Stamped, because this file runs once per browser project against one
    // database with no reseed between them. A fixed body is written by Chromium
    // and then found twice by Firefox, which fails as `Received: 2` and reads as
    // a duplicated-message bug in the product.
    const body = `typed with the keyboard ${String(Date.now())}`;

    await page.getByRole('textbox', { name: 'Message' }).focus();
    await page.keyboard.type(body);

    // Wait for the button to enable before pressing Enter. It is disabled while
    // the draft is empty, so it enabling is the observable signal that React has
    // processed the last keystroke -- and the submit handler reads the draft from
    // that state. Pressing Enter first sends a truncated body under Firefox,
    // which is a race in the test rather than in the app, but it is a real one.
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled();
    await page.keyboard.press('Enter');

    await expect(page.getByText(body)).toHaveCount(1);
  });

  test('names the channel in its heading', async ({ page }) => {
    await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
  });
});
