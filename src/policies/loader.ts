import { db } from '../db/connection';

/**
 * Per-child filter policy loader.
 *
 * The UDP DNS handler needs the box's child policy on every query. We
 * cache it in-process for 60 seconds so dashboard toggles propagate
 * within that window without hammering Postgres on every lookup.
 *
 * v1 assumption: one box → one child profile, so the cache is tiny
 * (one entry). When/if we go multi-child-per-box this still scales —
 * Map by child_profile_id with TTL is fine for hundreds of entries.
 *
 * Domains in the parent's allowed/blocked lists match either the exact
 * domain or any subdomain (consistent with how the categorized blocklist
 * matches). Stored lower-cased and trailing-dot-stripped.
 */

const TTL_MS = 60_000;

export interface FilterPolicy {
  child_profile_id: string;
  blocked_categories: string[];
  allowed_domains: string[];
  blocked_domains: string[];
  safe_search_enforce: boolean;
  youtube_restrict: boolean;
}

interface CachedEntry {
  policy: FilterPolicy | null;
  loadedAt: number;
}

const cache = new Map<string, CachedEntry>();

export async function getPolicyForChild(
  child_profile_id: string,
): Promise<FilterPolicy | null> {
  const now = Date.now();
  const entry = cache.get(child_profile_id);
  if (entry && now - entry.loadedAt < TTL_MS) {
    return entry.policy;
  }

  const result = await db.query(
    `SELECT child_profile_id,
            COALESCE(blocked_categories, '[]'::jsonb) AS blocked_categories,
            COALESCE(allowed_domains,    '[]'::jsonb) AS allowed_domains,
            COALESCE(blocked_domains,    '[]'::jsonb) AS blocked_domains,
            safe_search_enforce, youtube_restrict
     FROM filter_policies
     WHERE child_profile_id = $1
     LIMIT 1`,
    [child_profile_id],
  );

  let policy: FilterPolicy | null = null;
  if (result.rows[0]) {
    const row = result.rows[0];
    policy = {
      child_profile_id: row.child_profile_id,
      blocked_categories: normalizeArr(row.blocked_categories),
      allowed_domains: normalizeArr(row.allowed_domains).map(normalizeDomain),
      blocked_domains: normalizeArr(row.blocked_domains).map(normalizeDomain),
      safe_search_enforce: !!row.safe_search_enforce,
      youtube_restrict: !!row.youtube_restrict,
    };
  }
  cache.set(child_profile_id, { policy, loadedAt: now });
  return policy;
}

/**
 * Returns true if `domain` equals or is a subdomain of any entry in `list`.
 * Subdomain match is suffix on a label boundary — "foo.example.com"
 * matches an entry "example.com" but "fakeexample.com" does not.
 */
export function matchesDomainList(domain: string, list: string[]): boolean {
  if (!list.length) return false;
  const norm = normalizeDomain(domain);
  for (const entry of list) {
    if (!entry) continue;
    if (norm === entry) return true;
    if (norm.endsWith('.' + entry)) return true;
  }
  return false;
}

function normalizeArr(v: any): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      // fall through
    }
  }
  return [];
}

function normalizeDomain(d: string): string {
  return String(d).toLowerCase().replace(/\.$/, '').trim();
}

/**
 * Test helper. Don't call in production.
 */
export function _resetPolicyCacheForTests(): void {
  cache.clear();
}
