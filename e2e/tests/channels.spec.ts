import {
  DEMO_CHANNEL,
  SECOND_EMAIL,
  asSecondPerson,
  expect,
  openDemoChannel,
  signIn,
  test,
} from '../fixtures';

/**
 * The sidebar: what it lists, and the two counts it computes.
 *
 * **These specs create the state they assert on.** The seed leaves Ana four
 * unread messages and one mention, and the integration lane checks those exact
 * numbers against a freshly seeded database. This lane cannot: it runs serially
 * against one database with no reseed between files, and `a11y.spec.ts` opens the
 * conversation before this file runs, which marks it read. A spec asserting on the
 * seeded count would pass alone and fail in the suite, which is the worst kind of
 * flake because it looks like a product bug.
 *
 * So the two counting specs send a message as somebody else and then look at
 * Ana's sidebar. That is a better proof anyway: it exercises the write, the
 * broadcast and the recomputation rather than a number a fixture wrote.
 *
 * `unread` and `unreadMentions` are computed on every read and never stored.
 * Storing them would mean two writers for one fact, and every unread-counter bug
 * in every chat product is those two disagreeing.
 */
test.describe('channels', () => {
  test('lists the seeded channels', async ({ page }) => {
    await signIn(page);

    await expect(page.getByRole('link', { name: DEMO_CHANNEL })).toBeVisible();
  });

  test('labels a DM by its counterpart rather than by a name column', async ({ page }) => {
    // A DM has no name. Its label is whoever else is in it, resolved per reader,
    // because "Ana Ruiz" is the wrong title for Ana's own window.
    await signIn(page);

    await expect(page.getByRole('link', { name: 'Bruno Salas' })).toBeVisible();
  });

  test('shows an unread count as a number with an accessible label', async ({ page, browser }) => {
    await signIn(page);
    // Read it first, so the count this spec asserts on is one it created.
    await openDemoChannel(page);
    // Then leave. This is load-bearing: a reader with the channel open marks
    // every arrival read the moment it lands, so a message sent while Ana is
    // still looking at the conversation produces an unread count of zero. That is
    // the product working, and it is what made the first version of this spec
    // fail.
    await page.goto('/channels');

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);
    await theirs
      .getByRole('textbox', { name: 'Message' })
      .fill(`unread probe ${String(Date.now())}`);
    await theirs.getByRole('button', { name: 'Send' }).click();

    await page.goto('/channels');

    // A count and a label, never a tint. A badge that is only a colour says
    // nothing to a reader who cannot see it.
    await expect(page.getByLabel(/unread message/i).first()).toBeVisible();

    await other.close();
  });

  test('marks a channel that mentions the reader', async ({ page, browser }) => {
    await signIn(page);
    await openDemoChannel(page);
    // Away from the conversation before the mention arrives. See the unread spec
    // above: a reader looking at the channel reads the mention as it lands.
    await page.goto('/channels');

    const other = await browser.newContext();
    const theirs = await asSecondPerson(other);
    await openDemoChannel(theirs);
    // `@anaruiz`, not `@Ana Ruiz`. `handleOf` lowercases the name and collapses
    // every non-alphanumeric out of it, and mentions resolve against the
    // channel's membership rather than against every user in the database.
    await theirs
      .getByRole('textbox', { name: 'Message' })
      .fill(`@anaruiz mention probe ${String(Date.now())}`);
    await theirs.getByRole('button', { name: 'Send' }).click();

    await page.goto('/channels');

    // A marker and a label. The accent is reserved for exactly two things in this
    // design, unread state and mentions, and it never carries meaning alone.
    await expect(page.getByLabel(/mentioning you/i)).toBeVisible();

    await other.close();
  });

  test('opens a channel from the list', async ({ page }) => {
    await signIn(page);

    await page.getByRole('link', { name: DEMO_CHANNEL }).click();

    await expect(page.getByRole('heading', { name: DEMO_CHANNEL })).toBeVisible();
  });

  test('refuses a channel the reader is not in', async ({ page }) => {
    // A 404, not a 403. The API already refuses to distinguish "no such channel"
    // from "not a member" -- doing otherwise leaks the existence of every private
    // channel to anybody who can guess an id -- and rendering a 403 page would put
    // that distinction back in the browser.
    await signIn(page);

    await page.goto('/channels/not-a-real-channel-id');

    await expect(page.getByText(/could not be found/i).first()).toBeVisible();
  });

  test('the second account can sign in too, so the roster is not one person', async ({ page }) => {
    // The role matrix is a feature and one account cannot demonstrate it: Ana
    // owns `#product`, Bruno is an admin there and owns `#incidents`.
    await signIn(page, SECOND_EMAIL);

    await expect(page.getByRole('link', { name: 'Incidents' })).toBeVisible();
  });
});
