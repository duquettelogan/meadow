import { describe, it, expect } from 'vitest';
import {
  isCaptivePortalDomain,
  listCaptivePortalDomains,
} from '../../src/intel/captive-portal-allowlist';

describe('captive portal allowlist', () => {
  it('matches exact captive portal domains', () => {
    expect(isCaptivePortalDomain('captive.apple.com')).toBe(true);
    expect(isCaptivePortalDomain('connectivitycheck.gstatic.com')).toBe(true);
    expect(isCaptivePortalDomain('www.msftconnecttest.com')).toBe(true);
    expect(isCaptivePortalDomain('detectportal.firefox.com')).toBe(true);
  });

  it('matches subdomains of captive portal entries', () => {
    expect(isCaptivePortalDomain('foo.captive.apple.com')).toBe(true);
    expect(isCaptivePortalDomain('a.b.connectivitycheck.gstatic.com')).toBe(true);
  });

  it('rejects unrelated domains', () => {
    expect(isCaptivePortalDomain('google.com')).toBe(false);
    expect(isCaptivePortalDomain('apple.com')).toBe(false);
    expect(isCaptivePortalDomain('captiveapple.com')).toBe(false);
  });

  it('handles trailing dots and case', () => {
    expect(isCaptivePortalDomain('CAPTIVE.APPLE.COM')).toBe(true);
    expect(isCaptivePortalDomain('captive.apple.com.')).toBe(true);
  });

  it('handles empty input safely', () => {
    expect(isCaptivePortalDomain('')).toBe(false);
  });

  it('exposes the list for inspection', () => {
    const list = listCaptivePortalDomains();
    expect(list.length).toBeGreaterThan(5);
    expect(list).toContain('captive.apple.com');
  });
});
