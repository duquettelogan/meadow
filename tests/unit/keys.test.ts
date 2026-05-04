import { describe, it, expect } from 'vitest';
import {
  generateApiKey,
  hashApiKey,
  getKeyPrefix,
  safeEqual,
} from '../../src/auth/keys';

describe('api keys', () => {
  it('generates a key with the mk_ prefix', () => {
    const key = generateApiKey();
    expect(key.plaintext.startsWith('mk_')).toBe(true);
  });

  it('plaintext keys are unique across generations', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.plaintext).not.toBe(b.plaintext);
    expect(a.hash).not.toBe(b.hash);
  });

  it('hashApiKey is deterministic for the same input', () => {
    const a = hashApiKey('mk_abc123');
    const b = hashApiKey('mk_abc123');
    expect(a).toBe(b);
  });

  it('hashApiKey produces different hashes for different inputs', () => {
    expect(hashApiKey('mk_one')).not.toBe(hashApiKey('mk_two'));
  });

  it('hash matches the plaintext that generated it', () => {
    const key = generateApiKey();
    expect(hashApiKey(key.plaintext)).toBe(key.hash);
  });

  it('prefix is the first 8 characters of plaintext', () => {
    const key = generateApiKey();
    expect(key.prefix).toBe(key.plaintext.slice(0, 8));
    expect(getKeyPrefix(key.plaintext)).toBe(key.prefix);
  });

  describe('safeEqual', () => {
    it('returns true for equal strings', () => {
      expect(safeEqual('hello', 'hello')).toBe(true);
    });

    it('returns false for unequal strings of equal length', () => {
      expect(safeEqual('hello', 'world')).toBe(false);
    });

    it('returns false for strings of different lengths', () => {
      expect(safeEqual('short', 'longer string')).toBe(false);
    });

    it('returns false for empty input mismatches', () => {
      expect(safeEqual('', 'anything')).toBe(false);
    });
  });
});
