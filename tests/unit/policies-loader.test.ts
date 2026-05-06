import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/connection', () => ({
  db: { query: vi.fn() },
}));

import {
  getPolicyForChild,
  matchesDomainList,
  _resetPolicyCacheForTests,
} from '../../src/policies/loader';
import { db } from '../../src/db/connection';

const mockedQuery = vi.mocked(db.query);

function policyRow(overrides: Record<string, any> = {}) {
  return {
    child_profile_id: 'child-1',
    blocked_categories: [],
    allowed_domains: [],
    blocked_domains: [],
    safe_search_enforce: false,
    youtube_restrict: false,
    ...overrides,
  };
}

describe('matchesDomainList', () => {
  it('matches exact domain', () => {
    expect(matchesDomainList('roblox.com', ['roblox.com'])).toBe(true);
  });

  it('matches subdomain on label boundary', () => {
    expect(matchesDomainList('cdn.roblox.com', ['roblox.com'])).toBe(true);
    expect(matchesDomainList('a.b.roblox.com', ['roblox.com'])).toBe(true);
  });

  it('does not match prefix-spoof', () => {
    expect(matchesDomainList('fakeroblox.com', ['roblox.com'])).toBe(false);
  });

  it('returns false for empty list', () => {
    expect(matchesDomainList('any.com', [])).toBe(false);
  });

  it('handles case + trailing dots', () => {
    expect(matchesDomainList('FOO.example.com.', ['example.com'])).toBe(true);
  });
});

describe('getPolicyForChild', () => {
  beforeEach(() => {
    _resetPolicyCacheForTests();
    mockedQuery.mockReset();
  });

  it('returns null when no policy row exists', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [] } as any);
    const policy = await getPolicyForChild('nonexistent');
    expect(policy).toBeNull();
  });

  it('parses jsonb arrays from postgres', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        policyRow({
          allowed_domains: ['Roblox.com', 'minecraft.NET'],
          blocked_domains: ['tiktok.com'],
          safe_search_enforce: true,
        }),
      ],
    } as any);
    const policy = await getPolicyForChild('child-1');
    expect(policy?.allowed_domains).toEqual(['roblox.com', 'minecraft.net']);
    expect(policy?.blocked_domains).toEqual(['tiktok.com']);
    expect(policy?.safe_search_enforce).toBe(true);
  });

  it('parses string-encoded jsonb (older driver behavior)', async () => {
    mockedQuery.mockResolvedValueOnce({
      rows: [
        policyRow({
          allowed_domains: '["foo.com"]',
          blocked_domains: '["bar.com"]',
        }),
      ],
    } as any);
    const policy = await getPolicyForChild('child-1');
    expect(policy?.allowed_domains).toEqual(['foo.com']);
    expect(policy?.blocked_domains).toEqual(['bar.com']);
  });

  it('caches results for 60s window', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [policyRow()] } as any);
    await getPolicyForChild('child-1');
    await getPolicyForChild('child-1');
    await getPolicyForChild('child-1');
    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it('reset cache helper makes next call hit db', async () => {
    mockedQuery.mockResolvedValue({ rows: [policyRow()] } as any);
    await getPolicyForChild('child-1');
    _resetPolicyCacheForTests();
    await getPolicyForChild('child-1');
    expect(mockedQuery).toHaveBeenCalledTimes(2);
  });
});
