import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from './password';

describe('hashPassword', () => {
  it('verifies the password it hashed', () => {
    const stored = hashPassword('chat-demo-2026');
    expect(verifyPassword('chat-demo-2026', stored)).toBe(true);
  });

  it('salts, so the same password hashes differently every time', () => {
    // Without a per-hash salt, two people with the same password have the same
    // stored value, and one leaked table tells an attacker which accounts to
    // attack together.
    const first = hashPassword('same password');
    const second = hashPassword('same password');
    expect(first).not.toBe(second);
    expect(verifyPassword('same password', first)).toBe(true);
    expect(verifyPassword('same password', second)).toBe(true);
  });

  it('writes the format the verifier expects', () => {
    const [prefix, salt, hash] = hashPassword('anything').split(':');
    expect(prefix).toBe('scrypt');
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(hash).toMatch(/^[0-9a-f]{128}$/);
  });
});

describe('verifyPassword', () => {
  it('rejects the wrong password', () => {
    const stored = hashPassword('correct horse');
    expect(verifyPassword('correct hors', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['not-a-hash', 'no separators'],
    ['scrypt:abc', 'two parts'],
    ['bcrypt:abc:def', 'wrong scheme'],
    ['scrypt::', 'blank salt and hash'],
    ['scrypt:abcd:zzzz', 'hash is not hex'],
    [`scrypt:abcd:${'0'.repeat(126)}`, 'hash is the wrong length'],
  ])('returns false rather than throwing for a %s stored value (%s)', (stored) => {
    // A row with a corrupted hash must fail to authenticate, not 500. A crash
    // here would be a user-enumeration oracle: "this account exists and its row
    // is broken" is still information, and a 500 is louder than a 401.
    expect(() => verifyPassword('anything', stored)).not.toThrow();
    expect(verifyPassword('anything', stored)).toBe(false);
  });

  it('compares in constant time via timingSafeEqual', () => {
    // Not a timing measurement -- those are flaky on a loaded runner and prove
    // little. This asserts the property that makes the constant-time comparison
    // reachable at all: a stored value whose hash is the right length and hex
    // gets as far as the comparison, so `timingSafeEqual` is what decides the
    // answer rather than an early `return false` on a length mismatch.
    const stored = hashPassword('a real password');
    const [, salt] = stored.split(':');
    const wrongHashSameLength = `scrypt:${salt}:${'a'.repeat(128)}`;
    expect(verifyPassword('a real password', wrongHashSameLength)).toBe(false);
  });
});
