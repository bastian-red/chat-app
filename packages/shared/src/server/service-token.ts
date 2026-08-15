/**
 * The service token: one format, one secret, three processes.
 *
 * The web app owns the browser session (Auth.js) and **mints** a short-lived
 * HS256 token per server-side call. The REST API and the Socket.io gateway both
 * **verify** it, and neither holds a session: no cookie, no session table, no
 * database round trip on the auth path. That is what lets either of them run as
 * several replicas without a shared session store, and it is why the socket
 * handshake can reuse the token the REST client already carries instead of
 * inventing a second credential.
 *
 * It lives here, under `@chat/shared/server`, because "mint" and "verify" are the
 * same fact stated twice. When the minting side and the verifying side are two
 * files in two apps, a claim added to one and not read by the other is a silent
 * hole: the token still verifies and the field is simply absent downstream. This
 * module is the only description of what a token contains.
 *
 * It is **not** exported from `@chat/shared`. The root entry point is bundled for
 * the browser, and shipping a signing function to the browser would put the
 * ability to mint a token for any user id one `AUTH_SECRET` leak away from a
 * console.
 *
 * The API's guard and the gateway's handshake both wrap `verifyServiceToken` in
 * their own rejection -- a Nest `UnauthorizedException` and a Socket.io
 * connection error respectively -- which is why this returns a result rather than
 * throwing a framework error neither of them shares.
 */
import jwt from 'jsonwebtoken';

/** The claims a service token carries, and the only ones anything reads. */
export interface TokenUser {
  id: string;
  email: string;
  /**
   * Display name.
   *
   * Present so a message broadcast can carry its author's name without joining
   * `users` on the hot path of every send. It is display text,
   * never an authorisation input: nothing branches on it, so a token whose `name`
   * disagrees with the row grants nothing. `id` is what every permission check
   * reads.
   */
  name: string;
}

/**
 * How long a minted token is good for.
 *
 * Short, because it is minted per server-side call and never stored: the web app
 * signs one, uses it for a single request or a single socket handshake, and drops
 * it. The window only has to cover clock skew between processes plus the request
 * itself.
 */
export const SERVICE_TOKEN_TTL_SECONDS = 120;

export type TokenFailure = 'malformed' | 'signature' | 'expired' | 'claims';

export type VerifyResult = { ok: true; user: TokenUser } | { ok: false; reason: TokenFailure };

/**
 * Sign a token for one user.
 *
 * `algorithm: 'HS256'` is stated rather than left to the default so the mint and
 * the verify name the same algorithm in the same words. A mismatch here is not a
 * type error; it is a token every verifier rejects.
 */
export function mintServiceToken(
  user: TokenUser,
  secret: string,
  ttlSeconds: number = SERVICE_TOKEN_TTL_SECONDS,
): string {
  return jwt.sign({ email: user.email, name: user.name }, secret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: ttlSeconds,
  });
}

/**
 * Verify, with the algorithm list pinned.
 *
 * `algorithms: ['HS256']` is not a tidiness measure, it is the whole security
 * boundary. Without it `jsonwebtoken` accepts whatever the token's own header
 * asks for, and a token is attacker-controlled input: `{"alg":"none"}` verifies
 * with no signature at all, and `{"alg":"RS256"}` verifies an attacker-signed
 * token against the HMAC secret being read as a PEM public key. Both are one-line
 * forgeries of any user id.
 *
 * The `reason` is for the server's own logs. Callers must not put it in a
 * response: telling a client "expired" rather than "bad signature" says which
 * half of the token to keep working on.
 */
export function verifyServiceToken(token: string, secret: string): VerifyResult {
  let claims: unknown;
  try {
    claims = jwt.verify(token, secret, { algorithms: ['HS256'] });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) return { ok: false, reason: 'expired' };
    if (error instanceof jwt.JsonWebTokenError) return { ok: false, reason: 'signature' };
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims !== 'object' || claims === null) return { ok: false, reason: 'claims' };

  const { sub, email, name } = claims as { sub?: unknown; email?: unknown; name?: unknown };
  if (typeof sub !== 'string' || sub.length === 0) return { ok: false, reason: 'claims' };
  if (typeof email !== 'string' || email.length === 0) return { ok: false, reason: 'claims' };
  // Required, not defaulted. A token minted without it would broadcast activity
  // attributed to nobody -- a feed line reading "moved Fix login to Doing" with
  // no actor in front of the verb -- and a silent fallback here would hide that
  // from the minting side, which is the only place it is fixable.
  if (typeof name !== 'string' || name.length === 0) return { ok: false, reason: 'claims' };

  return { ok: true, user: { id: sub, email, name } };
}

/** The token out of `Authorization: Bearer <jwt>`, or null if there is not one. */
export function readBearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') return null;
  // Case-insensitive on the scheme because RFC 7235 says the scheme is, and a
  // client sending `bearer` is not the bug worth failing on.
  const match = /^bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}
