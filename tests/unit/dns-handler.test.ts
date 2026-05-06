import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as dnsPacket from 'dns-packet';

// Mock the dependencies before importing the module under test.
vi.mock('../../src/cache/blocklist', () => ({
  getBlockCategory: vi.fn(),
  CATEGORIES: ['malware', 'phishing', 'doh_bypass', 'adult'],
}));

vi.mock('../../src/cache/index', () => ({
  getCachedVerdict: vi.fn(),
  setCachedVerdict: vi.fn(),
  connectCache: vi.fn(),
}));

vi.mock('../../src/dns/upstream', () => ({
  forwardUpstream: vi.fn(),
}));

vi.mock('../../src/db/counters', () => ({
  incrementBlockCounter: vi.fn().mockResolvedValue(undefined),
}));

import { handleDnsQuery } from '../../src/dns/handler';
import { getBlockCategory } from '../../src/cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../../src/cache/index';
import { forwardUpstream } from '../../src/dns/upstream';
import { incrementBlockCounter } from '../../src/db/counters';
import type { FilterPolicy } from '../../src/policies/loader';

function makeQuery(domain: string, type: 'A' | 'AAAA' | 'MX' = 'A'): Buffer {
  return Buffer.from(
    dnsPacket.encode({
      type: 'query',
      id: 1234,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type, name: domain }],
    }),
  );
}

function decodeFirstAnswer(buf: Buffer) {
  const decoded = dnsPacket.decode(buf);
  return decoded.answers?.[0] ?? null;
}

function answerData(buf: Buffer): string | null {
  const ans = decodeFirstAnswer(buf);
  return ans ? String((ans as any).data) : null;
}

function answerType(buf: Buffer): string | null {
  const ans = decodeFirstAnswer(buf);
  return ans ? String(ans.type) : null;
}

function makePolicy(overrides: Partial<FilterPolicy> = {}): FilterPolicy {
  return {
    child_profile_id: 'child-uuid',
    blocked_categories: [],
    allowed_domains: [],
    blocked_domains: [],
    safe_search_enforce: false,
    youtube_restrict: false,
    ...overrides,
  };
}

describe('dns handler — base pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('blocks a domain in the blocklist by returning 0.0.0.0', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');

    const response = await handleDnsQuery(makeQuery('badsite.com'));

    expect(answerData(response)).toBe('0.0.0.0');
    expect(forwardUpstream).not.toHaveBeenCalled();
  });

  it('forwards allowed domain to upstream', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue(null);
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'good.com' }],
        answers: [{ type: 'A', name: 'good.com', ttl: 300, data: '93.184.216.34' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const query = makeQuery('good.com');
    const response = await handleDnsQuery(query);

    expect(forwardUpstream).toHaveBeenCalledWith(query);
    expect(answerData(response)).toBe('93.184.216.34');
  });

  it('uses cached block verdict without re-checking blocklist', async () => {
    vi.mocked(getCachedVerdict).mockResolvedValue('block');

    const response = await handleDnsQuery(makeQuery('cached-bad.com'));

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(answerData(response)).toBe('0.0.0.0');
  });

  it('uses cached allow verdict without re-checking blocklist', async () => {
    vi.mocked(getCachedVerdict).mockResolvedValue('allow');
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'cached-good.com' }],
        answers: [
          { type: 'A', name: 'cached-good.com', ttl: 300, data: '1.2.3.4' },
        ],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    await handleDnsQuery(makeQuery('cached-good.com'));

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(forwardUpstream).toHaveBeenCalled();
  });

  it('returns SERVFAIL when upstream fails', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue(null);
    vi.mocked(forwardUpstream).mockRejectedValue(new Error('upstream timeout'));

    const response = await handleDnsQuery(makeQuery('flaky.com'));
    const decoded = dnsPacket.decode(response);
    expect(decoded.answers?.length ?? 0).toBe(0);
  });

  it('handles malformed query packets gracefully', async () => {
    const garbage = Buffer.from([0xff, 0xff, 0xff]);
    const response = await handleDnsQuery(garbage);
    expect(() => dnsPacket.decode(response)).not.toThrow();
  });
});

describe('dns handler — AAAA blocking (Phase 1.2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('returns :: for blocked AAAA queries', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');
    const response = await handleDnsQuery(makeQuery('badsite.com', 'AAAA'));
    expect(answerType(response)).toBe('AAAA');
    expect(answerData(response)).toBe('::');
    expect(forwardUpstream).not.toHaveBeenCalled();
  });

  it('returns :: for parent-blocked AAAA queries', async () => {
    const policy = makePolicy({ blocked_domains: ['evil.com'] });
    const response = await handleDnsQuery(makeQuery('evil.com', 'AAAA'), {
      policy,
      childProfileId: 'child-uuid',
    });
    expect(answerType(response)).toBe('AAAA');
    expect(answerData(response)).toBe('::');
  });

  it('passes MX queries upstream without filtering', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'MX', name: 'badsite.com' }],
        answers: [{ type: 'MX', name: 'badsite.com', ttl: 300, data: { preference: 10, exchange: 'mx.badsite.com' } }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const response = await handleDnsQuery(makeQuery('badsite.com', 'MX'));

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(forwardUpstream).toHaveBeenCalled();
    expect(answerType(response)).toBe('MX');
  });
});

describe('dns handler — captive portal (Phase 1.3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('forwards captive-portal probes upstream even if blocklist matches', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult'); // would normally block
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'captive.apple.com' }],
        answers: [
          { type: 'A', name: 'captive.apple.com', ttl: 300, data: '17.253.144.10' },
        ],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const response = await handleDnsQuery(makeQuery('captive.apple.com'));

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(forwardUpstream).toHaveBeenCalled();
    expect(answerData(response)).toBe('17.253.144.10');
  });

  it('does not block captive-portal subdomain even with parent block list', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'connectivitycheck.gstatic.com' }],
        answers: [
          { type: 'A', name: 'connectivitycheck.gstatic.com', ttl: 300, data: '8.8.8.8' },
        ],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ blocked_domains: ['gstatic.com'] });
    const response = await handleDnsQuery(
      makeQuery('connectivitycheck.gstatic.com'),
      { policy, childProfileId: 'child-uuid' },
    );

    expect(answerData(response)).toBe('8.8.8.8');
  });
});

describe('dns handler — per-child policy (Phase 1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('parent allow list overrides category block', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'roblox.com' }],
        answers: [{ type: 'A', name: 'roblox.com', ttl: 300, data: '52.84.0.1' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ allowed_domains: ['roblox.com'] });
    const response = await handleDnsQuery(makeQuery('roblox.com'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(answerData(response)).toBe('52.84.0.1');
  });

  it('parent allow list matches subdomains', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'assets.roblox.com' }],
        answers: [{ type: 'A', name: 'assets.roblox.com', ttl: 300, data: '52.84.0.2' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ allowed_domains: ['roblox.com'] });
    const response = await handleDnsQuery(makeQuery('assets.roblox.com'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(answerData(response)).toBe('52.84.0.2');
  });

  it('parent block list sinkholes A record', async () => {
    const policy = makePolicy({ blocked_domains: ['bad-domain.com'] });
    const response = await handleDnsQuery(makeQuery('bad-domain.com'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(answerData(response)).toBe('0.0.0.0');
    expect(forwardUpstream).not.toHaveBeenCalled();
    expect(incrementBlockCounter).toHaveBeenCalledWith(
      'child-uuid',
      'parent_block',
    );
  });

  it('parent block list matches subdomains', async () => {
    const policy = makePolicy({ blocked_domains: ['bad-domain.com'] });
    const response = await handleDnsQuery(makeQuery('cdn.bad-domain.com'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(answerData(response)).toBe('0.0.0.0');
  });

  it('parent allow wins over parent block (allow checked first)', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'edge.com' }],
        answers: [{ type: 'A', name: 'edge.com', ttl: 300, data: '5.5.5.5' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({
      allowed_domains: ['edge.com'],
      blocked_domains: ['edge.com'],
    });
    const response = await handleDnsQuery(makeQuery('edge.com'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(answerData(response)).toBe('5.5.5.5');
    expect(incrementBlockCounter).not.toHaveBeenCalled();
  });

  it('no policy: pipeline falls back to category-only behavior', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');
    const response = await handleDnsQuery(makeQuery('badsite.com'));
    expect(answerData(response)).toBe('0.0.0.0');
  });
});

describe('dns handler — safe-search rewrites (Phase 1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('rewrites google.com → forcesafesearch.google.com when enforced', async () => {
    const policy = makePolicy({ safe_search_enforce: true });
    const response = await handleDnsQuery(makeQuery('www.google.com'), {
      policy,
    });
    const ans = decodeFirstAnswer(response);
    expect(ans?.type).toBe('CNAME');
    expect((ans as any).data).toBe('forcesafesearch.google.com');
    expect(forwardUpstream).not.toHaveBeenCalled();
  });

  it('rewrites Google ccTLD (google.co.uk) when enforced', async () => {
    const policy = makePolicy({ safe_search_enforce: true });
    const response = await handleDnsQuery(makeQuery('www.google.co.uk'), {
      policy,
    });
    const ans = decodeFirstAnswer(response);
    expect(ans?.type).toBe('CNAME');
    expect((ans as any).data).toBe('forcesafesearch.google.com');
  });

  it('rewrites bing.com → strict.bing.com', async () => {
    const policy = makePolicy({ safe_search_enforce: true });
    const response = await handleDnsQuery(makeQuery('www.bing.com'), { policy });
    const ans = decodeFirstAnswer(response);
    expect((ans as any).data).toBe('strict.bing.com');
  });

  it('parent allow on google.com bypasses safe-search', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'www.google.com' }],
        answers: [{ type: 'A', name: 'www.google.com', ttl: 300, data: '8.8.8.8' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({
      safe_search_enforce: true,
      allowed_domains: ['google.com'],
    });
    const response = await handleDnsQuery(makeQuery('www.google.com'), {
      policy,
    });
    expect(answerType(response)).toBe('A');
    expect(answerData(response)).toBe('8.8.8.8');
  });

  it('does not rewrite when safe_search_enforce is false', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'www.google.com' }],
        answers: [{ type: 'A', name: 'www.google.com', ttl: 300, data: '8.8.8.8' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ safe_search_enforce: false });
    const response = await handleDnsQuery(makeQuery('www.google.com'), {
      policy,
    });
    expect(answerType(response)).toBe('A');
  });
});

describe('dns handler — youtube restrict (Phase 1.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('rewrites www.youtube.com → restrictmoderate.youtube.com', async () => {
    const policy = makePolicy({ youtube_restrict: true });
    const response = await handleDnsQuery(makeQuery('www.youtube.com'), {
      policy,
    });
    const ans = decodeFirstAnswer(response);
    expect(ans?.type).toBe('CNAME');
    expect((ans as any).data).toBe('restrictmoderate.youtube.com');
  });

  it('does not rewrite when youtube_restrict is false', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: 'www.youtube.com' }],
        answers: [{ type: 'A', name: 'www.youtube.com', ttl: 300, data: '8.8.8.8' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ youtube_restrict: false });
    const response = await handleDnsQuery(makeQuery('www.youtube.com'), {
      policy,
    });
    expect(answerType(response)).toBe('A');
  });
});

describe('dns handler — crisis floor (existing)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('crisis floor forwards upstream and never calls counter', async () => {
    const upstreamResponse = Buffer.from(
      dnsPacket.encode({
        type: 'response',
        id: 1234,
        flags: dnsPacket.RECURSION_DESIRED,
        questions: [{ type: 'A', name: '988lifeline.org' }],
        answers: [{ type: 'A', name: '988lifeline.org', ttl: 300, data: '1.2.3.4' }],
      }),
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const policy = makePolicy({ blocked_domains: ['988lifeline.org'] });
    const response = await handleDnsQuery(makeQuery('988lifeline.org'), {
      policy,
      childProfileId: 'child-uuid',
    });

    expect(answerData(response)).toBe('1.2.3.4');
    expect(incrementBlockCounter).not.toHaveBeenCalled();
    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(getCachedVerdict).not.toHaveBeenCalled();
  });
});
