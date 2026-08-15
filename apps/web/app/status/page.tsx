import type { Metadata } from 'next';

import { probeHealth } from '../../lib/api';
import { realtimeBaseUrl, realtimeBaseUrl2, apiBaseUrl } from '../../lib/config';

/**
 * `/status`: every dependency this stack has, read live from both `/health`
 * endpoints.
 *
 * This is the page that makes the operability claim inspectable without a URL to
 * point at (`docs/SPECS.md` section 8). Nothing here is a static list of what
 * *would* be checked: every row is the answer a service just gave, and a service
 * that did not answer says so.
 *
 * **Both gateway replicas are probed, not one.** One replica green and one red is
 * this product's worst failure -- half the people in a channel stop seeing the
 * other half, and every process reports itself healthy -- and it is completely
 * invisible to a page that asks a single instance. The second replica is optional
 * (`REALTIME_BASE_URL_2` is unset in the documented single-replica `pnpm dev`),
 * and "not configured" is rendered as its own state rather than as a failure,
 * because a stack that was never meant to have two is not broken.
 *
 * **The state is a word.** `.pill` ships no green and no red variant. The same
 * rule that governs presence governs this table and for the same reason: it is
 * read in a glance, and two hues a reader cannot separate are one hue.
 *
 * Dynamic, and only this route. There is no `auth()` above it -- the root layout
 * deliberately does not read the session -- so making this page dynamic costs
 * nothing anywhere else.
 */
export const metadata: Metadata = {
  title: 'Status',
  description: 'Every dependency this stack has, what proves it is up, and which process asks.',
};

/**
 * Never cached, never prerendered.
 *
 * A cached status page is a status page that reports the state at build time,
 * which is worse than no page: it is confidently wrong for as long as the cache
 * lives.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface Row {
  service: string;
  endpoint: string;
  check: string;
  state: string;
  detail: string;
}

/** The shape both services answer with, read defensively because it is a probe. */
interface HealthBody {
  status?: unknown;
  version?: unknown;
  uptimeSeconds?: unknown;
  checks?: unknown;
  connectedSockets?: unknown;
}

function rowsFrom(
  service: string,
  endpoint: string,
  probe: Awaited<ReturnType<typeof probeHealth>>,
): Row[] {
  if (!probe.reachable) {
    const detail = (probe.body as { detail?: unknown }).detail;
    return [
      {
        service,
        endpoint,
        check: 'reachable',
        state: 'Unreachable',
        detail: typeof detail === 'string' ? detail : 'No answer.',
      },
    ];
  }

  const body = probe.body as HealthBody;
  const checks = Array.isArray(body.checks) ? body.checks : [];

  if (checks.length === 0) {
    return [
      {
        service,
        endpoint,
        check: 'answered',
        state: probe.status === 200 ? 'OK' : 'Degraded',
        detail: `HTTP ${String(probe.status)}, no checks reported.`,
      },
    ];
  }

  return checks.map((entry) => {
    const check = entry as {
      name?: unknown;
      status?: unknown;
      latencyMs?: unknown;
      detail?: unknown;
    };
    return {
      service,
      endpoint,
      check: typeof check.name === 'string' ? check.name : 'unknown',
      state: check.status === 'ok' ? 'OK' : 'Down',
      detail:
        typeof check.detail === 'string' && check.detail.length > 0
          ? check.detail
          : `${typeof check.latencyMs === 'number' ? String(Math.round(check.latencyMs)) : '?'} ms`,
    };
  });
}

export default async function StatusPage() {
  // Probed in parallel and never allowed to throw. A status page that 500s
  // because a dependency is down is a status page that cannot tell you the
  // dependency is down, which is the one job it has.
  const [api, gateway1, gateway2] = await Promise.all([
    probeHealth(apiBaseUrl),
    probeHealth(realtimeBaseUrl),
    realtimeBaseUrl2 === undefined ? Promise.resolve(null) : probeHealth(realtimeBaseUrl2),
  ]);

  const rows = [
    ...rowsFrom('api', `${apiBaseUrl}/health`, api),
    ...rowsFrom('realtime 1', `${realtimeBaseUrl}/health`, gateway1),
    ...(gateway2 === null
      ? [
          {
            service: 'realtime 2',
            endpoint: 'REALTIME_BASE_URL_2',
            check: 'configured',
            // Not a failure. The documented `pnpm dev` runs one gateway; two are
            // what `scripts/integration.sh` and `docker compose --profile app`
            // start, and a page that called a single-replica stack broken would be
            // wrong about the shape it is meant to describe.
            state: 'Not configured',
            detail: 'Single replica. Set REALTIME_BASE_URL_2 to probe a second.',
          },
        ]
      : rowsFrom('realtime 2', `${realtimeBaseUrl2}/health`, gateway2)),
  ];

  const everythingUp = rows.every((row) => row.state === 'OK' || row.state === 'Not configured');

  return (
    <div className="page">
      <div className="panel stack">
        <p className="eyebrow">Operability</p>
        <h1 className="panel-title">Status</h1>
        <p className="lede">
          {everythingUp
            ? 'Every dependency answered.'
            : 'Something is not answering. The failing check names itself below.'}
        </p>

        <table className="status-table">
          <caption className="sr-only">
            Every dependency, the process that checks it, and what it answered
          </caption>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Check</th>
              <th scope="col">State</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.service}-${row.check}`}>
                <th scope="row">{row.service}</th>
                <td>{row.check}</td>
                <td>
                  {/* The word is the state. No green pill, no red pill. */}
                  <span className="pill">{row.state}</span>
                </td>
                <td className="mono">{row.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="status-note">
          The gateway&apos;s check is not a ping. It publishes a nonce on the Socket.io
          adapter&apos;s own two Redis connections and waits to receive it back, because a gateway
          whose pub/sub is dead still serves every socket it holds and silently stops relaying to
          the other replica.
        </p>
        <p className="endpoint mono">
          {rows
            .map((row) => row.endpoint)
            .filter((value, index, all) => all.indexOf(value) === index)
            .join('  ')}
        </p>
      </div>
    </div>
  );
}
