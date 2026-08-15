import { expect, test } from '../fixtures';
import { apiBaseUrl, realtimeBaseUrl } from '../playwright.config';

/**
 * Both `/health` endpoints, and the page that renders them.
 *
 * This is the evidence for the operability claim. The portfolio publishes to
 * GitHub and hosts nothing, so there is no uptime number to point at; what
 * survives is a health check that a test actually exercises, and a status page
 * that shows what it said.
 *
 * The assertions are on the **body**, not on the status code. A liveness probe
 * that only reads 200 passes against a service holding a dead connection pool,
 * which is exactly the case these endpoints exist to catch.
 */
test.describe('health', () => {
  test('the API reports every dependency it actually exercised', async ({ request }) => {
    const response = await request.get(`${apiBaseUrl}/health`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.checks.map((check: { name: string }) => check.name).sort()).toEqual([
      'postgres',
      'redis',
      'uploads',
    ]);
  });

  test('the gateway reports a pub/sub round trip, not a ping', async ({ request }) => {
    // `adapter` is the check that separates this endpoint from a liveness probe.
    // It publishes a nonce on the Socket.io adapter's own Redis connections and
    // waits to receive it back, because a gateway whose subscriber has stopped
    // receiving serves every socket it holds perfectly and silently stops
    // relaying to the other replica.
    const response = await request.get(`${realtimeBaseUrl}/health`);

    expect(response.status()).toBe(200);
    const body = await response.json();
    const names = body.checks.map((check: { name: string }) => check.name);
    expect(names).toContain('adapter');
    expect(names).toContain('postgres');
    expect(body.checks.every((check: { status: string }) => check.status === 'ok')).toBe(true);
    // Not a check, and deliberately reported anyway: a green tick with zero
    // sockets after a deploy is either idle or unreachable, and the number is the
    // first question anybody asks.
    expect(typeof body.connectedSockets).toBe('number');
  });

  test('/status renders what both services answered, without a session', async ({ page }) => {
    // Public on purpose. A status page that needed a credential is a page nobody
    // can check during the outage it exists to describe.
    await page.goto('/status');

    await expect(page.getByRole('heading', { name: 'Status' })).toBeVisible();
    // Content from a real fetch, not a static list. `postgres` is a dependency
    // name out of a service's own /health body: it appears only if this page
    // reached that endpoint server-side.
    //
    // `.first()` because both services report a `postgres` check, which is the
    // point rather than an accident: the API and the gateway hold separate
    // connections and either can be the one that is down.
    await expect(page.getByRole('cell', { name: 'postgres' }).first()).toBeVisible();
    // `.first()` here too: this lane runs one gateway and points both replica
    // probes at it, so `adapter` appears twice. Two rows for one process is
    // honest -- the page describes what it asked, not what it assumes.
    await expect(page.getByRole('cell', { name: 'adapter' }).first()).toBeVisible();
    await expect(page.getByText('Every dependency answered.')).toBeVisible();
  });

  test('the status table says the state in words, not only in colour', async ({ page }) => {
    // The same rule as presence. Two hues a reader cannot separate are one hue,
    // and then the table says nothing at all.
    await page.goto('/status');

    await expect(page.getByText('OK').first()).toBeVisible();
  });
});
