import { db } from '../db/connection';
import { isBoxMode } from '../mode';
import { getBoxContext } from '../box/context';

/**
 * Per-family filter policy loader.
 *
 * In v1 every family has exactly one Household child (created at
 * signup, marked is_household=true) whose filter_policies row is the
 * single source of DNS-filtering rules for that family. This loader
 * resolves family_id → that policy, with an in-process 60s TTL cache
 * so dashboard toggles propagate within a minute without hammering PG
 * on every DNS query.
 *
 * Cache is keyed by family_id. v0 was keyed by child_profile_id; the
 * older getPolicyForChild + matchesDomainList exports kept around
 * lower in the file are still used by the resolver/UDP handler test
 * surface but are not the resolver's primary path.
 *
 * Domains in the parent's allowed/blocked lists match either the
 * exact domain or any subdomain (consistent with how the categorized
 * blocklist matches). Stored lower-cased and trailing-dot-stripped.
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

const familyCache = new Map<string, CachedEntry>();
const childCache = new Map<string, CachedEntry>();

export async function getPolicyForFamily(
  family_id: string,
): Promise<FilterPolicy | null> {
  // Box mode never touches PG — read the policy from the
  // API-fetched, in-memory box context (kept warm by
  // src/box/policy-sync.ts). The cached snapshot is keyed implicitly
  // by the box's own family_id; if a caller asks about a different
  // family_id (shouldn't happen in box mode) we return null rather
  // than leaking another family's cached state.
  if (isBoxMode()) {
    const ctx = getBoxContext();
    if (!ctx || ctx.family_id !== family_id) return null;
    return ctx.policy;
  }

  const now = Date.now();
  const entry = familyCache.get(family_id);
  if (entry && now - entry.loadedAt < TTL_MS) {
    return entry.policy;
  }

  const result = await db.query(
    `SELECT p.child_profile_id,
            COALESCE(p.blocked_categories, '[]'::jsonb) AS blocked_categories,
            COALESCE(p.allowed_domains,    '[]'::jsonb) AS allowed_domains,
            COALESCE(p.blocked_domains,    '[]'::jsonb) AS blocked_domains,
            p.safe_search_enforce, p.youtube_restrict
     FROM filter_policies p
     JOIN child_profiles c ON c.id = p.child_profile_id
     WHERE c.family_id = $1 AND c.is_household = true
     LIMIT 1`,
    [family_id],
  );

  const policy = parseRow(result.rows[0]);
  familyCache.set(family_id, { policy, loadedAt: now });
  return policy;
}

/**
 * Per-child loader, kept for back-compat with tests + any pre-v1
 * code path that still passes a child_profile_id directly. The
 * resolver's hot path uses getPolicyForFamily.
 */
export async function getPolicyForChild(
  child_profile_id: string,
): Promise<FilterPolicy | null> {
  const now = Date.now();
  const entry = childCache.get(child_profile_id);
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

  const policy = parseRow(result.rows[0]);
  childCache.set(child_profile_id, { policy, loadedAt: now });
  return policy;
}

function parseRow(row: any): FilterPolicy | null {
  if (!row) return null;
  return {
    child_profile_id: row.child_profile_id,
    blocked_categories: normalizeArr(row.blocked_categories),
    allowed_domains: normalizeArr(row.allowed_domains).map(normalizeDomain),
    blocked_domains: normalizeArr(row.blocked_domains).map(normalizeDomain),
    safe_search_enforce: !!row.safe_search_enforce,
    youtube_restrict: !!row.youtube_restrict,
  };
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
  familyCache.clear();
  childCache.clear();
}
