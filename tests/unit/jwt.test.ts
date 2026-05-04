import { describe, it, expect } from 'vitest';
import { signParentToken, verifyParentToken } from '../../src/auth/jwt';

describe('jwt', () => {
  it('signs and verifies a token round-trip', () => {
    const claims = {
      parent_id: '11111111-1111-1111-1111-111111111111',
      family_id: '22222222-2222-2222-2222-222222222222',
    };
    const token = signParentToken(claims);
    const decoded = verifyParentToken(token);
    expect(decoded).toEqual(claims);
  });

  it('returns null for a token with the wrong signature', () => {
    const claims = {
      parent_id: '11111111-1111-1111-1111-111111111111',
      family_id: '22222222-2222-2222-2222-222222222222',
    };
    const token = signParentToken(claims);
    const tampered = token.slice(0, -5) + 'aaaaa';
    expect(verifyParentToken(tampered)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(verifyParentToken('not.a.token')).toBeNull();
    expect(verifyParentToken('')).toBeNull();
    expect(verifyParentToken('garbage')).toBeNull();
  });

  it('two tokens for the same claims differ (iat)', async () => {
    const claims = {
      parent_id: '11111111-1111-1111-1111-111111111111',
      family_id: '22222222-2222-2222-2222-222222222222',
    };
    const a = signParentToken(claims);
    // Wait a second so iat differs.
    await new Promise((r) => setTimeout(r, 1100));
    const b = signParentToken(claims);
    expect(a).not.toBe(b);
  });
});
