import { describe, it, expect } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
} from '../../src/auth/passwords';

describe('passwords', () => {
  it('hashes and verifies a correct password', async () => {
    const hash = await hashPassword('correctpassword123');
    expect(await verifyPassword('correctpassword123', hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('correctpassword123');
    expect(await verifyPassword('wrongpassword', hash)).toBe(false);
  });

  it('produces different hashes for the same input (salt)', async () => {
    const a = await hashPassword('samepassword123');
    const b = await hashPassword('samepassword123');
    expect(a).not.toBe(b);
  });

  it('returns false for malformed hash without throwing', async () => {
    expect(await verifyPassword('whatever', 'not-a-real-hash')).toBe(false);
  });

  describe('validatePassword', () => {
    it('rejects short passwords', () => {
      expect(validatePassword('short')).toMatch(/at least/);
    });

    it('rejects non-strings', () => {
      // @ts-expect-error - intentional type violation
      expect(validatePassword(12345)).toMatch(/string/);
    });

    it('rejects very long passwords', () => {
      expect(validatePassword('a'.repeat(500))).toMatch(/too long/);
    });

    it('accepts a normal password', () => {
      expect(validatePassword('reasonable-password-123')).toBeNull();
    });
  });
});
