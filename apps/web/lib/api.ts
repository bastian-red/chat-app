import 'server-only';

/**
 * The server-side REST client.
 *
 * **A fresh token per call, never one cached in module scope.** Service tokens
 * live 120 seconds (`SERVICE_TOKEN_TTL_SECONDS`), and a module-level constant in a
 * long-lived Node process is valid for the first two minutes after a deploy and
 * rejected for the rest of the day. The symptom is an app that works when you
 * restart it and 401s later, which is the hardest shape of bug to reproduce.
 * Minting is an HMAC over a few dozen bytes; it is not worth caching.
 *
 * `import 'server-only'` is the enforcement, not a convention: a client component
 * that imported this module for its types would pull `jsonwebtoken` and
 * `AUTH_SECRET` into the browser bundle, and the build fails instead.
 *
 * Every response is parsed with the schema from `@chat/shared`. Not decoration:
 * the page renders whatever it is handed, so an API that started returning a
 * different shape would produce a blank region rather than an error, and the
 * failure would be attributed to CSS.
 */
import { mintServiceToken, type TokenUser } from '@chat/shared/server';
import type { z } from 'zod';

import { apiBaseUrl, authSecret } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  /**
   * Next's fetch cache setting.
   *
   * Defaulted to `no-store`. Every route this client serves is per-session and
   * changes on every message; a cached channel list is a sidebar showing a
   * conversation that ended an hour ago, and Next's default for a `fetch` in a
   * server component is to cache it.
   */
  cache?: RequestCache;
}

/**
 * One authenticated call, parsed.
 *
 * The schema is a parameter rather than a generic with a cast, so the parse is
 * impossible to skip: there is no overload that returns the raw JSON.
 */
export async function apiFetch<T>(
  user: TokenUser,
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      // Minted here, per call. See the header.
      authorization: `Bearer ${mintServiceToken(user, authSecret())}`,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    cache: options.cache ?? 'no-store',
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text === '' ? null : JSON.parse(text);
  } catch {
    // A non-JSON body from this API means a proxy or an error page answered
    // instead of the app. Reported below with the status, which is the only
    // useful thing left.
  }

  if (!response.ok) {
    const problem = payload as { code?: unknown; message?: unknown } | null;
    throw new ApiError(
      response.status,
      typeof problem?.code === 'string' ? problem.code : 'INTERNAL',
      typeof problem?.message === 'string'
        ? problem.message
        : `The API answered ${String(response.status)}.`,
    );
  }

  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    // The issues go to the server log, never to the page: they quote the payload
    // back, and the payload is somebody's conversation.
    console.error(`[web] ${path} did not match its contract`, parsed.error.issues);
    throw new ApiError(500, 'INTERNAL', 'The API returned something this app does not understand.');
  }

  return parsed.data;
}

/**
 * A health probe, which is the one call that must not throw.
 *
 * `/status` renders the failure rather than failing with it: a page that 500s
 * because a dependency is down is a page that cannot tell you the dependency is
 * down. Unauthenticated, because the endpoint is `@Public()` on both services.
 */
export async function probeHealth(
  baseUrl: string,
): Promise<{ reachable: boolean; status: number; body: unknown }> {
  try {
    const response = await fetch(`${baseUrl}/health`, { cache: 'no-store' });
    return { reachable: true, status: response.status, body: await response.json() };
  } catch (error) {
    return {
      reachable: false,
      status: 0,
      body: { detail: error instanceof Error ? error.message : String(error) },
    };
  }
}
