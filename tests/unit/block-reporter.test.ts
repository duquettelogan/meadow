import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';

import {
  recordBlock,
  flushOnce,
  setApiKeyGetter,
  _resetBlockReporterForTests,
  _queueSizeForTests,
} from '../../src/box/block-reporter';

const ORIGINAL_API_URL = process.env.API_URL;

const realFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(() => {
  process.env.API_URL = 'http://localhost:9999';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  _resetBlockReporterForTests();
  setApiKeyGetter(() => 'mk_testkey');
});

afterEach(() => {
  global.fetch = realFetch;
  if (ORIGINAL_API_URL === undefined) delete process.env.API_URL;
  else process.env.API_URL = ORIGINAL_API_URL;
  _resetBlockReporterForTests();
});

describe('recordBlock', () => {
  it('coalesces same (child, category, hour) into one bucket', () => {
    const t = Date.UTC(2026, 4, 6, 12, 0, 0); // 12:00 UTC
    recordBlock('child-a', 'malware', t);
    recordBlock('child-a', 'malware', t + 60_000); // +1min, same hour
    recordBlock('child-a', 'malware', t + 30 * 60_000); // +30min, same hour
    expect(_queueSizeForTests()).toBe(1);
  });

  it('splits buckets across different hours', () => {
    const t = Date.UTC(2026, 4, 6, 12, 0, 0);
    recordBlock('child-a', 'malware', t);
    recordBlock('child-a', 'malware', t + 60 * 60_000); // +1h
    expect(_queueSizeForTests()).toBe(2);
  });

  it('splits buckets across categories', () => {
    const t = Date.UTC(2026, 4, 6, 12, 0, 0);
    recordBlock('child-a', 'malware', t);
    recordBlock('child-a', 'phishing', t);
    expect(_queueSizeForTests()).toBe(2);
  });

  it('splits buckets across children', () => {
    const t = Date.UTC(2026, 4, 6, 12, 0, 0);
    recordBlock('child-a', 'malware', t);
    recordBlock('child-b', 'malware', t);
    expect(_queueSizeForTests()).toBe(2);
  });
});

describe('flushOnce', () => {
  it('returns 0 when the queue is empty (no fetch)', async () => {
    expect(await flushOnce()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 0 + defers when no api_key is configured', async () => {
    setApiKeyGetter(() => null);
    recordBlock('child-a', 'malware');
    expect(await flushOnce()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // Queue retained for the next attempt.
    expect(_queueSizeForTests()).toBe(1);
  });

  it('POSTs aggregated events and clears the queue on 200', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });
    const t = Date.UTC(2026, 4, 6, 12, 30, 0);
    recordBlock('child-a', 'malware', t);
    recordBlock('child-a', 'malware', t + 1000);
    recordBlock('child-b', 'phishing', t);

    const flushed = await flushOnce();
    expect(flushed).toBe(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:9999/api/v1/box/blocks');
    expect((init as { method: string }).method).toBe('POST');
    expect(
      (init as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer mk_testkey');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.events).toHaveLength(2);
    const aMalware = body.events.find(
      (e: { child_profile_id: string; category: string }) =>
        e.child_profile_id === 'child-a' && e.category === 'malware',
    );
    expect(aMalware.count).toBe(2);

    // Queue cleared.
    expect(_queueSizeForTests()).toBe(0);
  });

  it('retains the queue on a non-2xx response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });
    recordBlock('child-a', 'malware');
    const flushed = await flushOnce();
    expect(flushed).toBe(0);
    expect(_queueSizeForTests()).toBe(1);
  });

  it('retains the queue on 401 (api_key revoked)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    recordBlock('child-a', 'malware');
    const flushed = await flushOnce();
    expect(flushed).toBe(0);
    expect(_queueSizeForTests()).toBe(1);
  });

  it('retains the queue on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    recordBlock('child-a', 'malware');
    const flushed = await flushOnce();
    expect(flushed).toBe(0);
    expect(_queueSizeForTests()).toBe(1);
  });

  it('handles in-flight new events correctly (only the snapshotted count is removed)', async () => {
    // Prime: 2 in the queue.
    const t = Date.UTC(2026, 4, 6, 12, 0, 0);
    recordBlock('child-a', 'malware', t);
    recordBlock('child-a', 'malware', t + 1000);

    // Race: while the flush is "in flight", another event arrives.
    fetchMock.mockImplementationOnce(async () => {
      // Sneak a 3rd event into the same bucket BEFORE the flush
      // resolves, simulating a real-world racy resolver call.
      recordBlock('child-a', 'malware', t + 5000);
      return { ok: true, status: 200, json: async () => ({}) };
    });

    const flushed = await flushOnce();
    expect(flushed).toBe(1);
    // The bucket should still have count=1 left over (the in-flight
    // arrival), not 0.
    expect(_queueSizeForTests()).toBe(1);
  });
});
