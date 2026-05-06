import { describe, it, expect } from 'vitest';
import {
  generatePairingCode,
  normalizePairingCode,
  isValidPairingCode,
} from '../../src/box/codegen';

describe('pairing code generation', () => {
  it('generates 8-digit codes formatted XXXX-XXXX', () => {
    for (let i = 0; i < 25; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{4}-\d{4}$/);
    }
  });

  it('produces distinct codes per call (entropy sanity check)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generatePairingCode());
    // A handful of collisions in 100 draws from 100M is astronomically
    // unlikely; >= 99 unique is well within probability mass.
    expect(codes.size).toBeGreaterThanOrEqual(99);
  });

  it('normalizes "12345678" → "1234-5678"', () => {
    expect(normalizePairingCode('12345678')).toBe('1234-5678');
  });

  it('normalizes "1234-5678" → "1234-5678" (no change)', () => {
    expect(normalizePairingCode('1234-5678')).toBe('1234-5678');
  });

  it('returns null for malformed input', () => {
    expect(normalizePairingCode('123')).toBeNull();
    expect(normalizePairingCode('abcdefgh')).toBeNull();
    expect(normalizePairingCode('')).toBeNull();
  });

  it('isValidPairingCode accepts both forms', () => {
    expect(isValidPairingCode('1234-5678')).toBe(true);
    expect(isValidPairingCode('12345678')).toBe(true);
  });

  it('isValidPairingCode rejects malformed input', () => {
    expect(isValidPairingCode('1234-567')).toBe(false);
    expect(isValidPairingCode('12-345-678')).toBe(false);
    expect(isValidPairingCode('abcd-efgh')).toBe(false);
    expect(isValidPairingCode('')).toBe(false);
  });
});
