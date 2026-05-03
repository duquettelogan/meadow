import { db } from '../db/connection';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import { categorizeDomain } from './categorize';
import { isBlocked } from '../cache/blocklist';
import { incrementBlockCounter } from '../db/counters';

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

  // Step 0: cache check, fast path for repeat queries from the same device.
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

  // Step 1: device + filter policy lookup in one query.
  const deviceResult = await db.query(
    `SELECT d.id as device_id, d.child_profile_id,
            p.blocked_categories, p.blocked_domains, p.allowed_domains
     FROM devices d
     JOIN filter_policies p ON p.child_profile_id = d.child_profile_id
     WHERE d.device_token = $1`,
    [deviceToken]
  );

  // Unregistered device — fail closed.
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

  // Step 2: parent allowlist wins for explicit allows.
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

  // Step 4: shared blocklist (threat intel / StevenBlack hosts).
  const blocklisted = await isBlocked(normalized);
  if (blocklisted) {
    await setCachedVerdict(deviceToken, normalized, 'block', TTL.block);
    await incrementBlockCounter(childProfileId, 'adult');
    return {
      domain: normalized,
      verdict: 'block',
      category: 'adult',
      reason: 'blocklist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 5: hardcoded allowlist — skip AI call for known-safe domains.
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

  // Step 6: AI categorization — closes the "block anything bad" gap for
  // domains that aren't in any blocklist. Uses Cloudflare Domain Intel.
  const blockedCategories: string[] = profile.blocked_categories || [];
  const category = await categorizeDomain(normalized);

  // Globally bad category match (adult, malware, weapons, etc.).
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

  // Per-child parent-blocked category.
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

  // Step 7: default allow — short TTL so we re-check after intel updates.
  await setCachedVerdict(deviceToken, normalized, 'allow', TTL.uncategorized);
  return {
    domain: normalized,
    verdict: 'allow',
    category: 'uncategorized',
    reason: 'default_allow',
    latency_ms: Date.now() - start,
  };
}
