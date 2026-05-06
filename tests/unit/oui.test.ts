import { describe, it, expect, beforeEach } from 'vitest';
import { lookupOui, _resetOuiCacheForTests } from '../../src/box/oui';

describe('OUI lookup', () => {
  beforeEach(() => _resetOuiCacheForTests());

  it('matches a known prefix from the shipped oui.txt', () => {
    // Raspberry Pi Foundation — definitely in our shipped subset.
    expect(lookupOui('B8:27:EB:01:02:03')).toMatch(/Raspberry Pi/i);
  });

  it('case-insensitive', () => {
    expect(lookupOui('b8:27:eb:01:02:03')).toMatch(/Raspberry Pi/i);
    expect(lookupOui('B8-27-EB-01-02-03')).toMatch(/Raspberry Pi/i);
    expect(lookupOui('b827eb010203')).toMatch(/Raspberry Pi/i);
  });

  it('returns undefined for unknown prefix', () => {
    expect(lookupOui('00:00:5E:00:53:01')).toBeUndefined();
  });

  it('handles too-short input safely', () => {
    expect(lookupOui('00:00')).toBeUndefined();
    expect(lookupOui('')).toBeUndefined();
  });
});
