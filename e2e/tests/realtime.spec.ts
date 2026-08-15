import {
  DEMO_CHANNEL,
  SECOND_NAME,
  asSecondPerson,
  expect,
  openDemoChannel,
  signIn,
  test,
} from '../fixtures';

/**
 * Two people, two browser contexts, one conversation.
 *
 * **Contexts, not pages.** Two pages in one context share a cookie jar, so they
 * are one session and one person, and a spec that used them would prove a browser
 * can render the same conversation twice rather than that two people see each
 * other's messages.
 *
 * This is the browser-level half of the project's headline claim. The
 * process-level half -- that a message sent through the gateway on :4100 reaches a
 * client on :4101 -- is in `apps/api/test/realtime.integration.test.ts`, because
 * it needs two gateway processes and a browser cannot tell which one it is talking
 * to.
 */
test.describe('two people in one channel', () => {
  test('a message crosses without a reload', async ({ page, browser }) => {
    await signIn(page);
    await openDemoChannel(page);

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);

    const body = `crossing between contexts ${String(Date.now())}`;
    await theirs.getByRole('textbox', { name: 'Message' }).fill(body);
    await theirs.getByRole('button', { name: 'Send' }).click();

    // No reload anywhere in this test. The only way this text reaches the first
    // page is the socket.
    await expect(page.getByText(body)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(body)).toHaveCount(1);

    await other.close();
  });

  test('the typing indicator names who is typing', async ({ page, browser }) => {
    await signIn(page);
    await openDemoChannel(page);

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);

    await theirs.getByRole('textbox', { name: 'Message' }).fill('halfway through a sentence');
    // The typing event fires from the change handler, so waiting for the button
    // to enable is what says React has processed the input and the emit has been
    // issued. Without it the assertion below races the keystroke under Firefox.
    await expect(theirs.getByRole('button', { name: 'Send' })).toBeEnabled();

    // Names, not a count. "Somebody is typing" tells a reader nothing they can
    // act on, and the set is bounded by the membership and a five-second TTL, so
    // sending all of it costs nothing.
    // Scoped to the live region, not to the page. The conversation itself
    // contains a seeded line about typing indicators written by Bruno, so a bare
    // text match resolves to the message list as well and fails in strict mode.
    // Two elements carry `role="status"` here -- the connection state and this --
    // so the filter is what picks the right one.
    await expect(
      page.getByRole('status').filter({ hasText: new RegExp(`${SECOND_NAME}.*typing`) }),
    ).toBeVisible({ timeout: 15_000 });

    await other.close();
  });

  test('the roster shows the other person as online', async ({ page, browser }) => {
    await signIn(page);
    await openDemoChannel(page);

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);

    const roster = page.getByRole('list', { name: 'Members' });
    const row = roster.getByRole('listitem').filter({ hasText: SECOND_NAME });

    // The word, which is the state. The dot beside it is decoration and is
    // `aria-hidden`, because a screen reader announcing "black circle Online" is
    // worse off than one announcing "Online".
    await expect(row.getByText('Online')).toBeVisible({ timeout: 15_000 });

    await other.close();
  });

  test('a reader who goes away and comes back catches up with no gap and no duplicate', async ({
    page,
    browser,
  }) => {
    await signIn(page);
    await openDemoChannel(page);

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);

    // The second person stops receiving. `context.setOffline` cuts the transport
    // without closing the tab, which is what a train tunnel looks like: the page
    // is still there and the socket is not.
    await other.setOffline(true);

    const stamp = String(Date.now());
    const bodies = [`gap one ${stamp}`, `gap two ${stamp}`, `gap three ${stamp}`];
    for (const body of bodies) {
      await page.getByRole('textbox', { name: 'Message' }).fill(body);
      await page.getByRole('button', { name: 'Send' }).click();
      await expect(page.getByText(body)).toBeVisible();
    }

    await other.setOffline(false);

    // All three, each exactly once. This is the assertion the reorder buffer and
    // `channel.catchup` exist for: the reconnect delivers nothing by itself, so
    // the only evidence of the hole is that the next seq is not the expected one,
    // and the only repair is the catch-up the client asks for.
    for (const body of bodies) {
      await expect(theirs.getByText(body)).toBeVisible({ timeout: 30_000 });
      await expect(theirs.getByText(body)).toHaveCount(1);
    }

    await other.close();
  });

  test('the connection state is a word', async ({ page }) => {
    await signIn(page);
    await openDemoChannel(page);

    // "Live" or "Reconnecting", never a coloured dot alone. The dot is a `::before`
    // and the word is what a screen reader in the live region hears.
    await expect(page.getByText('Live', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
  });
});
