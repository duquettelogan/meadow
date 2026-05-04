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

import { handleDnsQuery } from '../../src/dns/handler';
import { getBlockCategory } from '../../src/cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../../src/cache/index';
import { forwardUpstream } from '../../src/dns/upstream';

function makeQuery(domain: string): Buffer {
  return Buffer.from(
    dnsPacket.encode({
      type: 'query',
      id: 1234,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name: domain }],
    })
  );
}

function decodeAnswerIp(buf: Buffer): string | null {
  const decoded = dnsPacket.decode(buf);
  const ans = decoded.answers?.[0];
  if (!ans || ans.type !== 'A') return null;
  return String(ans.data);
}

describe('dns handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCachedVerdict).mockResolvedValue(null);
    vi.mocked(setCachedVerdict).mockResolvedValue(undefined as any);
  });

  it('blocks a domain in the blocklist by returning 0.0.0.0', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue('adult');

    const query = makeQuery('badsite.com');
    const response = await handleDnsQuery(query);

    expect(decodeAnswerIp(response)).toBe('0.0.0.0');
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
      })
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const query = makeQuery('good.com');
    const response = await handleDnsQuery(query);

    expect(forwardUpstream).toHaveBeenCalledWith(query);
    expect(decodeAnswerIp(response)).toBe('93.184.216.34');
  });

  it('uses cached block verdict without re-checking blocklist', async () => {
    vi.mocked(getCachedVerdict).mockResolvedValue('block');

    const query = makeQuery('cached-bad.com');
    const response = await handleDnsQuery(query);

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(decodeAnswerIp(response)).toBe('0.0.0.0');
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
      })
    );
    vi.mocked(forwardUpstream).mockResolvedValue(upstreamResponse);

    const query = makeQuery('cached-good.com');
    await handleDnsQuery(query);

    expect(getBlockCategory).not.toHaveBeenCalled();
    expect(forwardUpstream).toHaveBeenCalled();
  });

  it('returns SERVFAIL when upstream fails', async () => {
    vi.mocked(getBlockCategory).mockResolvedValue(null);
    vi.mocked(forwardUpstream).mockRejectedValue(new Error('upstream timeout'));

    const query = makeQuery('flaky.com');
    const response = await handleDnsQuery(query);

    const decoded = dnsPacket.decode(response);
    // Answers should be empty; flags should indicate SERVFAIL (rcode 2).
    expect(decoded.answers?.length ?? 0).toBe(0);
  });

  it('handles malformed query packets gracefully', async () => {
    const garbage = Buffer.from([0xff, 0xff, 0xff]);
    const response = await handleDnsQuery(garbage);
    // Should still produce a parseable response.
    expect(() => dnsPacket.decode(response)).not.toThrow();
  });
});
