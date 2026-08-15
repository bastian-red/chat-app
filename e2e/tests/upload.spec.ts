import type { Page } from '@playwright/test';

import { expect, openDemoChannel, signIn, test } from '../fixtures';
import { apiBaseUrl } from '../playwright.config';

/**
 * Uploads, through the API rather than the composer.
 *
 * The composer has no attach control yet, so these drive the route directly with
 * a signed-in request. That is not a shortcut around a UI check: the properties
 * worth proving here are all server-side, and every one of them is invisible from
 * a browser.
 *
 * The token comes from the web app's own `/api/socket-token` route, which mints
 * for the caller's session. It is the same token the socket handshake carries --
 * one secret, three verifiers -- so using it here also proves the API accepts what
 * the web app mints.
 */
async function tokenFor(page: Page): Promise<string> {
  const response = await page.request.get('/api/socket-token');
  expect(response.status()).toBe(200);
  return (await response.json()).token as string;
}

/** A PNG header, as bytes. Written as numbers so this file holds no binary. */
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

test.describe('uploads', () => {
  test('stores the type sniffed from the bytes, not the one the client declared', async ({
    page,
  }) => {
    await signIn(page);
    await openDemoChannel(page);
    const token = await tokenFor(page);

    // The client says `text/html` and sends a PNG. Believing the header is how an
    // attachment becomes a stored cross-site script: the stored type is what the
    // download route sets on the way back out.
    const response = await page.request.post(`${apiBaseUrl}/uploads`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: {
        file: { name: 'lies.png', mimeType: 'text/html', buffer: PNG },
      },
    });

    expect(response.status()).toBe(201);
    const body = await response.json();
    expect(body.contentType).toBe('image/png');
  });

  test('serves it back behind the session, never inline', async ({ page }) => {
    await signIn(page);
    await openDemoChannel(page);
    const token = await tokenFor(page);

    const uploaded = await page.request.post(`${apiBaseUrl}/uploads`, {
      headers: { authorization: `Bearer ${token}` },
      multipart: { file: { name: 'mine.png', mimeType: 'image/png', buffer: PNG } },
    });
    const { id } = await uploaded.json();

    const download = await page.request.get(`${apiBaseUrl}/attachments/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(download.status()).toBe(200);
    // `attachment`, even for an image, and `nosniff` beside it. A browser told to
    // render a file this server sniffed as octet-stream is how a stored file
    // becomes a page in the API's own origin.
    expect(download.headers()['content-disposition']).toContain('attachment');
    expect(download.headers()['x-content-type-options']).toBe('nosniff');
  });

  test('refuses an unauthenticated upload', async ({ request }) => {
    const response = await request.post(`${apiBaseUrl}/uploads`, {
      multipart: { file: { name: 'anon.png', mimeType: 'image/png', buffer: PNG } },
    });

    expect(response.status()).toBe(401);
  });
});
