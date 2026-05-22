/**
 * Box runtime context.
 *
 * In box-mode the Pi has NO database. The context that the resolver
 * needs (family_id, the synthetic Household child id, and the family's
 * filter policy) is fetched from the cloud API on a timer and held in
 * memory + mirrored to Redis.
 *
 * Sources:
 *   - /etc/meadow/box.env  (key=value, written by bootstrap.ts after
 *                           the box-originated pairing flow finishes)
 *   - GET /api/v1/box/policy with the device's api_key
 *
 * Caching:
 *   - in-memory `cached`     primary read path; sub-microsecond
 *   - Redis  meadow:box:context  10-minute TTL; survives a process
 *                                restart and lets us serve the
 *                                last-known-good policy if the API
 *                                is unreachable at boot
 *
 * Refresh: src/box/policy-sync.ts wakes every 5 minutes and rotates
 * both caches with a fresh API fetch. On failure the in-memory copy
 * stays put; we keep serving DNS with whatever we last had.
 *
 * Edge cases:
 *   - api_key revoked (401): leave cached policy in place, log loud,
 *     keep serving until the box is re-paired. Refusing to filter
 *     because the API said "no" is a worse user experience than a
 *     few extra hours on the last-known policy.
 *   - no api_key on disk yet (fresh install pre-pair): return null
 *     and let the resolver fail-open.
 */

import * as fs from 'fs';
import { cacheGetJson, cacheSetJson } from '../cache/index';
import type { FilterPolicy } from '../policies/loader';
import { reportAuthFailure, reportAuthSuccess } from './repair';

// Resolved at call time (not module load) so tests can set
// boxEnvFile() / apiUrl() in beforeEach without having to re-import
// the module.
const boxEnvFile = () => process.env.BOX_ENV_FILE || '/etc/meadow/box.env';
const legacyStateFile = () => process.env.STATE_FILE || '/etc/meadow/state.json';
const apiUrl = () => process.env.API_URL || 'https://meadow-api-prod.fly.dev';
const REDIS_KEY = 'meadow:box:context';
const REDIS_TTL_SECONDS = 600; // 10 minutes; refreshed every 5 min by policy-sync

interface PersistedState {
  hardware_id: string;
  api_key?: string;
  device_id?: string;
}

export interface BoxContext {
  device_id: string;
  family_id: string;
  household_child_id: string | null;
  api_key: string | null;
  policy: FilterPolicy | null;
  policy_version: string | null;
}

let cached: BoxContext | null = null;

function readBoxEnv(): PersistedState | null {
  if (!fs.existsSync(boxEnvFile())) return null;
  try {
    const out: any = {};
    for (const line of fs.readFileSync(boxEnvFile(), 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key === 'MEADOW_HARDWARE_ID') out.hardware_id = value;
      if (key === 'MEADOW_API_KEY') out.api_key = value;
      if (key === 'MEADOW_DEVICE_ID') out.device_id = value;
    }
    if (!out.hardware_id) return null;
    return out as PersistedState;
  } catch (err) {
    console.error(`[box] failed to read ${boxEnvFile()}:`, err);
    return null;
  }
}

function readLegacyStateJson(): PersistedState | null {
  if (!fs.existsSync(legacyStateFile())) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyStateFile(), 'utf-8'));
    if (parsed && typeof parsed.hardware_id === 'string') {
      return parsed;
    }
  } catch (err) {
    console.error(`[box] failed to parse ${legacyStateFile()}:`, err);
  }
  return null;
}

interface PolicyResponse {
  family_id: string;
  household_child_id: string;
  policy_version: string;
  categories_blocked: string[];
  parent_blocklist: string[];
  parent_allowlist: string[];
  safe_search_enforce: boolean;
  youtube_restrict: boolean;
}

async function fetchPolicy(apiKey: string): Promise<PolicyResponse | null> {
  const url = `${apiUrl().replace(/\/$/, '')}/api/v1/box/policy`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401) {
      console.error(
        '[box] /box/policy returned 401 — api_key revoked? not rotating cache',
      );
      reportAuthFailure('policy-sync');
      return null;
    }
    if (!res.ok) {
      console.error(`[box] /box/policy returned ${res.status}`);
      return null;
    }
    reportAuthSuccess();
    return (await res.json()) as PolicyResponse;
  } catch (err) {
    console.error('[box] /box/policy fetch failed:', (err as Error).message);
    return null;
  }
}

function policyResponseToFilterPolicy(resp: PolicyResponse): FilterPolicy {
  return {
    child_profile_id: resp.household_child_id,
    blocked_categories: resp.categories_blocked,
    allowed_domains: resp.parent_allowlist,
    blocked_domains: resp.parent_blocklist,
    safe_search_enforce: resp.safe_search_enforce,
    youtube_restrict: resp.youtube_restrict,
  };
}

/**
 * Load the box context. In box-mode this fetches from the cloud API
 * (see file header). Idempotent — safe to call multiple times. Returns
 * null when the box is not yet paired (no api_key on disk).
 */
export async function loadBoxContext(): Promise<BoxContext | null> {
  if (cached) return cached;

  const state = readBoxEnv() ?? readLegacyStateJson();
  if (!state) {
    console.log(
      `[box] no state at ${boxEnvFile()} (legacy: ${legacyStateFile()}) — running unpaired`,
    );
    return null;
  }
  if (!state.device_id || !state.api_key) {
    console.log('[box] state has no device_id/api_key — not paired yet');
    return null;
  }

  // Try the API first. If it works, refresh both caches.
  const fresh = await fetchPolicy(state.api_key);
  if (fresh) {
    cached = {
      device_id: state.device_id,
      family_id: fresh.family_id,
      household_child_id: fresh.household_child_id,
      api_key: state.api_key,
      policy: policyResponseToFilterPolicy(fresh),
      policy_version: fresh.policy_version,
    };
    try {
      await cacheSetJson(REDIS_KEY, cached, REDIS_TTL_SECONDS);
    } catch (err) {
      console.warn(
        '[box] failed to mirror context to Redis:',
        (err as Error).message,
      );
    }
    console.log(
      `[box] context loaded via API: family=${cached.family_id} household=${cached.household_child_id ?? 'missing'} policy_version=${cached.policy_version}`,
    );
    return cached;
  }

  // API failed. Try the Redis fallback so a transient outage doesn't
  // take the box's filtering offline.
  console.warn('[box] API fetch failed; trying Redis fallback');
  try {
    const stale = await cacheGetJson<BoxContext>(REDIS_KEY);
    if (stale && stale.api_key) {
      // Trust the on-disk api_key over whatever's in Redis (key
      // rotation invalidates the cached snapshot's identity, but the
      // policy fields are still useful as last-known-good).
      cached = { ...stale, api_key: state.api_key, device_id: state.device_id };
      console.warn(
        `[box] running on stale Redis cache — family=${cached.family_id} (last fetched before this boot)`,
      );
      return cached;
    }
  } catch (err) {
    console.error('[box] Redis fallback failed:', (err as Error).message);
  }

  // Both API and Redis failed. Caller (UDP DNS server) will fail-open.
  console.error(
    '[box] no policy available — DNS will pass through unfiltered until API recovers',
  );
  return null;
}

/**
 * Refresh the in-memory + Redis policy snapshots from the cloud API.
 * Called by src/box/policy-sync.ts on a timer. Returns true on a
 * successful refresh, false on any failure (cached snapshot left
 * intact in that case so we keep serving the last-known policy).
 */
export async function refreshBoxPolicy(): Promise<boolean> {
  if (!cached || !cached.api_key) return false;
  const fresh = await fetchPolicy(cached.api_key);
  if (!fresh) return false;
  cached = {
    ...cached,
    family_id: fresh.family_id,
    household_child_id: fresh.household_child_id,
    policy: policyResponseToFilterPolicy(fresh),
    policy_version: fresh.policy_version,
  };
  try {
    await cacheSetJson(REDIS_KEY, cached, REDIS_TTL_SECONDS);
  } catch {
    // best-effort
  }
  return true;
}

/**
 * Synchronous accessor — the resolver hot path uses this. Returns
 * null when the box isn't paired or the context hasn't been loaded.
 */
export function getBoxContext(): BoxContext | null {
  return cached;
}

/**
 * Test helper. Don't call in production.
 */
export function _resetBoxContextForTests(): void {
  cached = null;
}

/**
 * Test helper — directly inject a context (bypasses fetch + Redis).
 * Used by integration tests to set up a known box state without
 * having to run the full box-pair + cache prime sequence.
 */
export function _setBoxContextForTests(ctx: BoxContext | null): void {
  cached = ctx;
}
