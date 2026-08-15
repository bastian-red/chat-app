import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import {
  mintServiceToken,
  readBearer,
  SERVICE_TOKEN_TTL_SECONDS,
  verifyServiceToken,
  type TokenUser,
} from './service-token';

const SECRET = 'test-secret-at-least-sixteen-chars';
const USER: TokenUser = { id: 'usr_1', email: 'ana@chat.local', name: 'Ana Ruiz' };

describe('mint and verify', () => {
  it('round-trips every claim', () => {
    // The property the whole module exists for: what the web app signs is exactly
    // what the API and the gateway read. A claim added on one side and not on the
    // other verifies fine and arrives undefined, which is the failure this pins.
    const result = verifyServiceToken(mintServiceToken(USER, SECRET), SECRET);
    expect(result).toEqual({ ok: true, user: USER });
  });

  it('puts the user id in `sub`, where a JWT reader expects it', () => {
    const decoded = jwt.decode(mintServiceToken(USER, SECRET)) as Record<string, unknown>;
    expect(decoded.sub).toBe('usr_1');
  });

  it('expires, and by default within two minutes', () => {
    const decoded = jwt.decode(mintServiceToken(USER, SECRET)) as { exp: number; iat: number };
    expect(decoded.exp - decoded.iat).toBe(SERVICE_TOKEN_TTL_SECONDS);
    expect(SERVICE_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(120);
  });

  it('signs HS256, which is the one algorithm verification accepts', () => {
    const header = JSON.parse(
      Buffer.from(mintServiceToken(USER, SECRET).split('.')[0]!, 'base64url').toString('utf8'),
    ) as { alg: string };
    expect(header.alg).toBe('HS256');
  });
});

describe('verifyServiceToken refuses', () => {
  it('a token signed with a different secret', () => {
    const token = mintServiceToken(USER, 'a-different-secret-entirely');
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'signature' });
  });

  it('an expired token', () => {
    const token = mintServiceToken(USER, SECRET, -1);
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'expired' });
  });

  it('alg: none, which is a signature-free forgery of any user id', () => {
    // Hand-built rather than signed, because `jsonwebtoken` refuses to produce
    // one. This is exactly the shape an attacker sends.
    const encode = (value: object): string =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
      sub: 'usr_victim',
      email: 'victim@chat.local',
      name: 'Victim',
    })}.`;

    expect(verifyServiceToken(token, SECRET).ok).toBe(false);
  });

  it('an HS512 token signed with the same secret', () => {
    // Without an explicit `algorithms` list, `jsonwebtoken` honours whatever the
    // token's own header asks for, and the header is attacker-controlled.
    const token = jwt.sign({ sub: 'usr_1', email: 'a@b.c', name: 'A' }, SECRET, {
      algorithm: 'HS512',
    });
    expect(verifyServiceToken(token, SECRET).ok).toBe(false);
  });

  it('a malformed token', () => {
    expect(verifyServiceToken('not-a-jwt', SECRET).ok).toBe(false);
    expect(verifyServiceToken('a.b.c', SECRET).ok).toBe(false);
  });

  it.each([
    ['no sub', { email: 'a@b.c', name: 'A' }],
    ['no email', { sub: 'usr_1', name: 'A' }],
    ['no name', { sub: 'usr_1', email: 'a@b.c' }],
    ['an empty name', { sub: 'usr_1', email: 'a@b.c', name: '' }],
  ])('a valid signature with %s', (_label, claims) => {
    const token = jwt.sign(claims, SECRET, { algorithm: 'HS256', expiresIn: '2m' });
    expect(verifyServiceToken(token, SECRET)).toEqual({ ok: false, reason: 'claims' });
  });
});

describe('readBearer', () => {
  it('reads the token out of a well-formed header', () => {
    expect(readBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('accepts a lower-case scheme, because RFC 7235 says the scheme is case-insensitive', () => {
    expect(readBearer('bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([
    ['a missing header', undefined],
    ['a header with no scheme', 'abc.def.ghi'],
    ['a Basic header', 'Basic dXNlcjpwYXNz'],
    ['a scheme with no token', 'Bearer '],
  ])('returns null for %s', (_label, header) => {
    expect(readBearer(header)).toBeNull();
  });

  it('takes the first value when a header arrives repeated', () => {
    expect(readBearer(['Bearer first.token.here', 'Bearer second'])).toBe('first.token.here');
  });
});
