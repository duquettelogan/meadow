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
    // Decoded includes jti/iat/exp on top of the input claims (Phase 4.3).
    expect(decoded).toMatchObject(claims);
    expect(typeof decoded?.jti).toBe('string');
    expect(typeof decoded?.iat).toBe('number');
    expect(typeof decoded?.exp).toBe('number');
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

  it('two tokens for the same claims differ (jti)', () => {
    const claims = {
      parent_id: '11111111-1111-1111-1111-111111111111',
      family_id: '22222222-2222-2222-2222-222222222222',
    };
    const a = signParentToken(claims);
    const b = signParentToken(claims);
    // jti is randomized per call, so back-to-back signs produce
    // different tokens even within the same second.
    expect(a).not.toBe(b);
  });
});
