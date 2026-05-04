import { describe, it, expect } from 'vitest';
import {
  SignupBody,
  LoginBody,
  CreateChildBody,
  ResolveBody,
  RegisterDeviceBody,
  UpdatePolicyBody,
} from '../../src/api/validation';

describe('validation schemas', () => {
  describe('SignupBody', () => {
    it('accepts valid input and lowercases email', () => {
      const r = SignupBody.parse({
        email: 'TEST@Example.com',
        password: 'longenoughpass1',
      });
      expect(r.email).toBe('test@example.com');
    });

    it('rejects invalid email', () => {
      expect(() =>
        SignupBody.parse({ email: 'notanemail', password: 'longenoughpass1' })
      ).toThrow();
    });

    it('rejects short password', () => {
      expect(() =>
        SignupBody.parse({ email: 'a@b.com', password: 'short' })
      ).toThrow();
    });

    it('rejects unknown fields', () => {
      expect(() =>
        SignupBody.parse({
          email: 'a@b.com',
          password: 'longenoughpass1',
          extra: 'nope',
        })
      ).toThrow();
    });
  });

  describe('LoginBody', () => {
    it('accepts even short passwords for login (real check happens server-side)', () => {
      expect(() =>
        LoginBody.parse({ email: 'a@b.com', password: 'x' })
      ).not.toThrow();
    });

    it('still rejects invalid email', () => {
      expect(() =>
        LoginBody.parse({ email: 'invalid', password: 'whatever' })
      ).toThrow();
    });
  });

  describe('CreateChildBody', () => {
    it('accepts a valid name and tier', () => {
      expect(CreateChildBody.parse({ name: 'Emma', tier: 'strict' })).toEqual({
        name: 'Emma',
        tier: 'strict',
      });
    });

    it('accepts name without tier (default applied server-side)', () => {
      expect(CreateChildBody.parse({ name: 'Emma' })).toEqual({ name: 'Emma' });
    });

    it('rejects invalid tier', () => {
      expect(() =>
        CreateChildBody.parse({ name: 'Emma', tier: 'paranoid' })
      ).toThrow();
    });

    it('rejects empty name', () => {
      expect(() => CreateChildBody.parse({ name: '' })).toThrow();
    });
  });

  describe('ResolveBody', () => {
    it('accepts a normal domain', () => {
      expect(ResolveBody.parse({ domain: 'example.com' })).toEqual({
        domain: 'example.com',
      });
    });

    it('rejects domain with bad characters', () => {
      expect(() => ResolveBody.parse({ domain: 'evil.com/path' })).toThrow();
      expect(() => ResolveBody.parse({ domain: 'has spaces' })).toThrow();
    });
  });

  describe('RegisterDeviceBody', () => {
    it('accepts valid payload', () => {
      const r = RegisterDeviceBody.parse({
        platform: 'ios',
        device_token: 'abcdef123456',
      });
      expect(r.platform).toBe('ios');
    });

    it('rejects unknown platform', () => {
      expect(() =>
        RegisterDeviceBody.parse({
          platform: 'toaster',
          device_token: 'abcdef123456',
        })
      ).toThrow();
    });

    it('rejects malformed device_token', () => {
      expect(() =>
        RegisterDeviceBody.parse({
          platform: 'ios',
          device_token: 'has spaces',
        })
      ).toThrow();
    });
  });

  describe('UpdatePolicyBody', () => {
    it('accepts partial updates', () => {
      expect(
        UpdatePolicyBody.parse({ safe_search_enforce: false })
      ).toEqual({ safe_search_enforce: false });
    });

    it('rejects invalid domain in lists', () => {
      expect(() =>
        UpdatePolicyBody.parse({ blocked_domains: ['evil.com', 'bad space'] })
      ).toThrow();
    });

    it('rejects oversized arrays', () => {
      const huge = new Array(600).fill('a.com');
      expect(() =>
        UpdatePolicyBody.parse({ blocked_domains: huge })
      ).toThrow();
    });
  });
});
