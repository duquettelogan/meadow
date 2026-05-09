import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// IMPORTANT: tests/setup.ts opens a Redis client connection. Box-context
// uses cacheGetJson / cacheSetJson which delegate to that same client.
// As long as REDIS_URL is set (it is), the cache module connects on
// first call and these tests share the connection with the rest of the
// suite — no extra teardown needed.

import {
  loadBoxContext,
  refreshBoxPolicy,
  getBoxContext,
  _resetBoxContextForTests,
} from '../../src/box/context';
import { cacheSetJson, cacheGetJson } from '../../src/cache/index';

const ORIGINAL_BOX_ENV_FILE = process.env.BOX_ENV_FILE;
const ORIGINAL_API_URL = process.env.API_URL;

let tmpDir: string;
let boxEnvPath: string;

function writeBoxEnv(content: string) {
  fs.writeFileSync(boxEnvPath, content);
}

function makePolicyResponse(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    family_id: 'fam-aaaa-bbbb',
    household_child_id: 'hh-cccc-dddd',
    policy_version: 'abc123def456',
    categories_blocked: ['malware', 'phishing'],
    parent_blocklist: ['blocked.example'],
    parent_allowlist: [],
    safe_search_enforce: true,
    youtube_restrict: true,
    blocklist_versions: {},
    ...overrides,
  };
}

const realFetch = global.fetch;
const fetchMock = vi.fn();

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meadow-box-ctx-'));
  boxEnvPath = path.join(tmpDir, 'box.env');
  process.env.BOX_ENV_FILE = boxEnvPath;
  process.env.API_URL = 'http://localhost:9999';
  global.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
  _resetBoxContextForTests();
  // Wipe the Redis fallback key so test-to-test pollution doesn't
  // confuse the "API failure" branch.
  await cacheSetJson('meadow:box:context', null, 1).catch(() => {});
});

afterEach(() => {
  global.fetch = realFetch;
  if (ORIGINAL_BOX_ENV_FILE === undefined) delete process.env.BOX_ENV_FILE;
  else process.env.BOX_ENV_FILE = ORIGINAL_BOX_ENV_FILE;
  if (ORIGINAL_API_URL === undefined) delete process.env.API_URL;
  else process.env.API_URL = ORIGINAL_API_URL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetBoxContextForTests();
});

describe('loadBoxContext (box mode, API-backed)', () => {
  it('returns null when box.env is missing (unpaired)', async () => {
    const ctx = await loadBoxContext();
    expect(ctx).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when box.env has hardware_id but no api_key (mid-pair)', async () => {
    writeBoxEnv('MEADOW_HARDWARE_ID=hw_abc123abc123abc1\n');
    const ctx = await loadBoxContext();
    expect(ctx).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches /box/policy and populates the cache + Redis', async () => {
    writeBoxEnv(
      [
        'MEADOW_HARDWARE_ID=hw_abc',
        'MEADOW_API_KEY=mk_deadbeef',
        'MEADOW_DEVICE_ID=dev-ffff',
      ].join('\n'),
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makePolicyResponse(),
    });

    const ctx = await loadBoxContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.family_id).toBe('fam-aaaa-bbbb');
    expect(ctx!.household_child_id).toBe('hh-cccc-dddd');
    expect(ctx!.api_key).toBe('mk_deadbeef');
    expect(ctx!.device_id).toBe('dev-ffff');
    expect(ctx!.policy_version).toBe('abc123def456');
    expect(ctx!.policy?.blocked_categories).toEqual(['malware', 'phishing']);
    expect(ctx!.policy?.blocked_domains).toEqual(['blocked.example']);
    expect(ctx!.policy?.safe_search_enforce).toBe(true);

    // fetch was called with the right URL + auth header.
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:9999/api/v1/box/policy');
    expect(
      (init as { headers: Record<string, string> }).headers.Authorization,
    ).toBe('Bearer mk_deadbeef');

    // Redis got a copy.
    const cached = await cacheGetJson<typeof ctx>('meadow:box:context');
    expect(cached?.family_id).toBe('fam-aaaa-bbbb');
  });

  it('subsequent loadBoxContext() calls use the in-memory cache (no second fetch)', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_a', 'MEADOW_DEVICE_ID=d'].join(
        '\n',
      ),
    );
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => makePolicyResponse(),
    });
    await loadBoxContext();
    await loadBoxContext();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the Redis cache when the API errors at boot', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_b', 'MEADOW_DEVICE_ID=d2'].join(
        '\n',
      ),
    );

    // Pre-seed Redis with last-known-good context (as if a prior boot
    // succeeded and stamped it).
    await cacheSetJson(
      'meadow:box:context',
      {
        device_id: 'd2',
        family_id: 'fam-stale',
        household_child_id: 'hh-stale',
        api_key: 'mk_old',
        policy_version: 'oldhash',
        policy: {
          child_profile_id: 'hh-stale',
          blocked_categories: ['malware'],
          allowed_domains: [],
          blocked_domains: [],
          safe_search_enforce: true,
          youtube_restrict: true,
        },
      },
      600,
    );

    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    const ctx = await loadBoxContext();
    expect(ctx).not.toBeNull();
    expect(ctx!.family_id).toBe('fam-stale');
    // On-disk api_key wins over the stale Redis snapshot's api_key.
    expect(ctx!.api_key).toBe('mk_b');
    expect(ctx!.policy?.blocked_categories).toEqual(['malware']);
  });

  it('treats a 401 as "do not rotate cache" and returns null when there is no Redis fallback', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_revoked', 'MEADOW_DEVICE_ID=d'].join(
        '\n',
      ),
    );
    // Make sure Redis has nothing for this key (don't cross-pollinate
    // with the prior test's seeded snapshot).
    await cacheSetJson('meadow:box:context', null, 1);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const ctx = await loadBoxContext();
    expect(ctx).toBeNull();
  });

  it('returns null when fetch throws AND Redis is empty', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_c', 'MEADOW_DEVICE_ID=d'].join(
        '\n',
      ),
    );
    await cacheSetJson('meadow:box:context', null, 1);
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const ctx = await loadBoxContext();
    expect(ctx).toBeNull();
  });
});

describe('refreshBoxPolicy', () => {
  it('updates the cached snapshot when the API returns a new policy_version', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_a', 'MEADOW_DEVICE_ID=d'].join(
        '\n',
      ),
    );
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makePolicyResponse({ policy_version: 'v1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () =>
          makePolicyResponse({
            policy_version: 'v2',
            parent_blocklist: ['newly-blocked.example'],
          }),
      });

    await loadBoxContext();
    expect(getBoxContext()?.policy_version).toBe('v1');

    const ok = await refreshBoxPolicy();
    expect(ok).toBe(true);
    expect(getBoxContext()?.policy_version).toBe('v2');
    expect(getBoxContext()?.policy?.blocked_domains).toEqual([
      'newly-blocked.example',
    ]);
  });

  it('returns false and leaves the cached snapshot alone when refresh errors', async () => {
    writeBoxEnv(
      ['MEADOW_HARDWARE_ID=hw', 'MEADOW_API_KEY=mk_a', 'MEADOW_DEVICE_ID=d'].join(
        '\n',
      ),
    );
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => makePolicyResponse({ policy_version: 'v1' }),
      })
      .mockResolvedValueOnce({ ok: false, status: 503 });

    await loadBoxContext();
    const before = getBoxContext();
    const ok = await refreshBoxPolicy();
    expect(ok).toBe(false);
    expect(getBoxContext()).toEqual(before);
  });

  it('returns false when called before loadBoxContext primed the cache', async () => {
    const ok = await refreshBoxPolicy();
    expect(ok).toBe(false);
  });
});
