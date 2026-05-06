import { db } from '../db/connection';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import { categorizeDomain } from './categorize';
import { getBlockCategory } from '../cache/blocklist';
import { incrementBlockCounter } from '../db/counters';
import { isCrisisDomain } from '../intel/crisis-floor';
import { isCaptivePortalDomain } from '../intel/captive-portal-allowlist';

const HARDCODED_ALLOWLIST = new Set([
  'google.com',
  'youtube.com',
  'wikipedia.org',
  'khanacademy.org',
  'nasa.gov',
  'britannica.com',
]);

const TTL: Record<string, number> = {
  allow: 86400,
  block: 21600,
  uncategorized: 3600,
};

export type Verdict = 'allow' | 'block';

export interface ResolverResult {
  domain: string;
  verdict: Verdict;
  category: string | null;
  reason: string;
  latency_ms: number;
}

export async function resolve(
  domain: string,
  deviceToken: string
): Promise<ResolverResult> {
  const start = Date.now();
  const normalized = domain.toLowerCase().replace(/\.$/, '');

  // Step -1: crisis floor — checked before EVERYTHING else, including
  // the per-device cache. Crisis-resource lookups must:
  //   - return allow regardless of any other rule
  //   - leave NO entry in our cache (so an admin can't see a crisis
  //     domain in cache state)
  //   - never call incrementBlockCounter
  // Same privacy contract as the UDP path. See src/intel/crisis-floor.ts.
  if (isCrisisDomain(normalized)) {
    return {
      domain: normalized,
      verdict: 'allow',
      category: null,
      reason: 'crisis_floor',
      latency_ms: Date.now() - start,
    };
  }

  // Step -0.5: captive portal allowlist — also checked before the cache
  // so devices behind the resolver can complete connectivity checks even
  // if a stale cache entry says block.
  if (isCaptivePortalDomain(normalized)) {
    return {
      domain: normalized,
      verdict: 'allow',
      category: null,
      reason: 'captive_portal',
      latency_ms: Date.now() - start,
    };
  }

  // Step 0: per-device cache.
  const cached = await getCachedVerdict(deviceToken, normalized);
  if (cached) {
    return {
      domain: normalized,
      verdict: cached as Verdict,
      category: 'cached',
      reason: 'cache_hit',
      latency_ms: Date.now() - start,
    };
  }

  // Step 1: device + filter policy.
  const deviceResult = await db.query(
    `SELECT d.id as device_id, d.child_profile_id,
            p.blocked_categories, p.blocked_domains, p.allowed_domains
     FROM devices d
     JOIN filter_policies p ON p.child_profile_id = d.child_profile_id
     WHERE d.device_token = $1`,
    [deviceToken]
  );

  if (deviceResult.rows.length === 0) {
    return {
      domain: normalized,
      verdict: 'block',
      category: null,
      reason: 'unregistered_device',
      latency_ms: Date.now() - start,
    };
  }

  const profile = deviceResult.rows[0];
  const childProfileId: string = profile.child_profile_id;

  // Step 2: parent allowlist.
  const allowedDomains: string[] = profile.allowed_domains || [];
  if (allowedDomains.includes(normalized)) {
    await setCachedVerdict(deviceToken, normalized, 'allow', TTL.allow);
    return {
      domain: normalized,
      verdict: 'allow',
      category: null,
      reason: 'parent_allowlist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 3: parent blocklist.
  const blockedDomains: string[] = profile.blocked_domains || [];
  if (blockedDomains.includes(normalized)) {
    await setCachedVerdict(deviceToken, normalized, 'block', TTL.block);
    await incrementBlockCounter(childProfileId, 'parent_block');
    return {
      domain: normalized,
      verdict: 'block',
      category: 'parent_block',
      reason: 'parent_blocklist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 4: categorized blocklist (malware, phishing, doh_bypass, adult).
  // The blocklist returns the matched category so we can report it accurately.
  const blockCategory = await getBlockCategory(normalized);
  if (blockCategory) {
    await setCachedVerdict(deviceToken, normalized, 'block', TTL.block);
    await incrementBlockCounter(childProfileId, blockCategory);
    return {
      domain: normalized,
      verdict: 'block',
      category: blockCategory,
      reason: 'blocklist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 5: hardcoded allowlist (skip AI for known-safe).
  if (HARDCODED_ALLOWLIST.has(normalized)) {
    await setCachedVerdict(deviceToken, normalized, 'allow', TTL.allow);
    return {
      domain: normalized,
      verdict: 'allow',
      category: 'safe',
      reason: 'allowlist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 6: AI categorization for novel domains.
  const blockedCategories: string[] = profile.blocked_categories || [];
  const category = await categorizeDomain(normalized);

  if (category.matchedCategory) {
    await setCachedVerdict(deviceToken, normalized, 'block', TTL.block);
    await incrementBlockCounter(childProfileId, category.matchedCategory);
    return {
      domain: normalized,
      verdict: 'block',
      category: category.matchedCategory,
      reason: 'ai_categorized',
      latency_ms: Date.now() - start,
    };
  }

  const parentBlockedHit = category.categories.find((c) =>
    blockedCategories.includes(c)
  );
  if (parentBlockedHit) {
    await setCachedVerdict(deviceToken, normalized, 'block', TTL.block);
    await incrementBlockCounter(childProfileId, parentBlockedHit);
    return {
      domain: normalized,
      verdict: 'block',
      category: parentBlockedHit,
      reason: 'parent_category',
      latency_ms: Date.now() - start,
    };
  }

  // Step 7: default allow.
  await setCachedVerdict(deviceToken, normalized, 'allow', TTL.uncategorized);
  return {
    domain: normalized,
    verdict: 'allow',
    category: 'uncategorized',
    reason: 'default_allow',
    latency_ms: Date.now() - start,
  };
}
