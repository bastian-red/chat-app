/**
 * Every environment variable this app reads, in one module, split by who can see
 * it.
 *
 * **The split is the whole point.** `NEXT_PUBLIC_*` names are inlined into the
 * browser bundle by `next build` through *textual substitution*, which has two
 * consequences that bite in opposite directions:
 *
 * - They must be read as `process.env.NEXT_PUBLIC_X` **literally**, at the top
 *   level. A computed lookup (`process.env[name]`) is not substituted, so the
 *   value is `undefined` in the browser and defined on the server, and the bug
 *   only appears in the half of the app nobody is looking at.
 * - They are baked at build time. `docker run -e NEXT_PUBLIC_API_BASE_URL=...`
 *   against an already-built image does nothing, which is why
 *   `infra/Dockerfile.web` takes them as build ARGs.
 *
 * The server-only names are the opposite: they must never end up in a component
 * that ships to the browser. `AUTH_SECRET` is the one that matters, and it is read
 * in `auth.ts` and in `lib/service-token.ts` and nowhere a client component can
 * import.
 *
 * Every read is spelled `env.NAME` or `process.env.NAME` literally, because
 * `scripts/env-contract.mjs` finds them by regex and turbo runs in strict env
 * mode: a name it cannot see is a name that is silently stripped.
 */

/**
 * Where the browser reaches the API.
 *
 * Not `API_BASE_URL`, which is the server-to-server one (`http://api:4000` inside
 * compose). Handing the browser that value produces a page that renders on the
 * server and fails every fetch in the tab.
 */
export const publicApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000';

/**
 * Where the browser opens its socket.
 *
 * The one that matters most in this app: a wrong value here produces a page that
 * renders perfectly, signs in, lists every channel, and never receives a single
 * message. Nothing errors, because a socket that cannot connect just retries.
 */
export const publicRealtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'http://localhost:4100';

/**
 * Where the server reaches the API.
 *
 * Read on the server only. Inside compose this is a service name; on a developer's
 * machine it is the same localhost URL the browser uses, which is why the two are
 * easy to confuse and why they are separate names.
 */
export const apiBaseUrl = process.env.API_BASE_URL ?? 'http://localhost:4000';

/** Where the server probes the first gateway's health, for `/status`. */
export const realtimeBaseUrl = process.env.REALTIME_BASE_URL ?? 'http://localhost:4100';

/**
 * The second gateway, when one is running.
 *
 * `undefined` means "not running", not "running on 4101". `/status` probes both
 * because one replica green and one red is this product's worst failure and is
 * invisible to a page that asks only one; a page that assumed a second replica
 * existed would report a stack problem for a single-replica setup, which is the
 * documented `pnpm dev` shape.
 */
export const realtimeBaseUrl2 = process.env.REALTIME_BASE_URL_2;

/** This app's own origin, for Auth.js and for absolute links. */
export const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';

/** Reported on `/status`, so two builds are tellable apart. */
export const appVersion = process.env.APP_VERSION ?? '0.0.0';

/**
 * The shared HS256 secret.
 *
 * Server-only, and asserted here rather than where it is used: a missing secret
 * does not merely break sign-in, it makes every REST call and every socket
 * handshake fail at once, which presents as a conversation that renders and never
 * moves. Failing at import time in a server module turns that into one message.
 */
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret === undefined || secret.length < 16) {
    throw new Error(
      'AUTH_SECRET must be set and at least 16 characters. Without it the web app cannot mint ' +
        'the service token the API and the gateway both verify.',
    );
  }
  return secret;
}
