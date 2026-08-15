/**
 * Password hashing.
 *
 * Lives under `src/server/` and is reachable only as `@chat/shared/server`, never
 * from the package root. The web app imports `@chat/shared` for contracts, roles
 * and the due-date helpers, and that import is bundled for the browser; a root
 * export that pulled in `node:crypto` would either break the client build or,
 * worse, succeed against a polyfill and ship a password hasher to the browser.
 *
 * That subpath is also the reason `packages/config/tsconfig.node.json` sets
 * `moduleResolution: Node16` rather than the classic `Node` resolver, which
 * predates the `exports` field and cannot see a subpath at all.
 *
 * scrypt rather than bcrypt or argon2, and no dependency: it is in Node's
 * standard library, it is memory-hard, and the alternatives here are native
 * modules that have to be rebuilt for every base image. Layer 1 of
 * search-before-building -- the standard library already solves this.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const PREFIX = 'scrypt';

/** Hash a password as `scrypt:<saltHex>:<hashHex>`. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const derived = scryptSync(password, salt, KEY_LENGTH).toString('hex');
  return `${PREFIX}:${salt}:${derived}`;
}

/**
 * Verify in constant time.
 *
 * `expected === actual` on the derived key leaks, through timing, how many
 * leading bytes matched. That is not theoretical for a hex comparison in a hot
 * login route: it turns a 2^512 search into 128 sequential ones.
 *
 * Returns false rather than throwing for a malformed stored value. A row with a
 * corrupted hash must fail to authenticate, not 500 -- a crash here is a
 * user-enumeration oracle of a different kind.
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const [, salt, hashHex] = parts;
  if (!salt || !hashHex || hashHex.length !== KEY_LENGTH * 2) return false;

  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = scryptSync(password, salt, KEY_LENGTH);
  return timingSafeEqual(expected, actual);
}
