import { db } from '../db/connection';

const BLOCKED_CATEGORIES = [
  'adult',
  'gambling',
  'weapons',
  'drugs',
  'hate',
  'malware',
  'phishing',
];

const HARDCODED_BLOCKLIST: Record<string, string> = {
  'pornhub.com': 'adult',
  'xvideos.com': 'adult',
  'bet365.com': 'gambling',
  'draftkings.com': 'gambling',
};

const HARDCODED_ALLOWLIST = new Set([
  'google.com',
  'youtube.com',
  'wikipedia.org',
  'khanacademy.org',
  'nasa.gov',
  'britannica.com',
]);

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

  // Step 1: look up device and child profile
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

  // Step 2: check parent allow overrides first
  const allowedDomains: string[] = profile.allowed_domains || [];
  if (allowedDomains.includes(normalized)) {
    await logEvent(profile, normalized, 'allow', null, start);
    return {
      domain: normalized,
      verdict: 'allow',
      category: null,
      reason: 'parent_allowlist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 3: check parent block overrides
  const blockedDomains: string[] = profile.blocked_domains || [];
  if (blockedDomains.includes(normalized)) {
    await logEvent(profile, normalized, 'block', 'parent_block', start);
    return {
      domain: normalized,
      verdict: 'block',
      category: 'parent_block',
      reason: 'parent_blocklist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 4: check hardcoded blocklist
  const blockedCategory = HARDCODED_BLOCKLIST[normalized];
  if (blockedCategory) {
const profileCategories: string[] = profile.blocked_categories?.length > 0
  ? profile.blocked_categories
  : BLOCKED_CATEGORIES;    if (profileCategories.includes(blockedCategory)) {
      await logEvent(profile, normalized, 'block', blockedCategory, start);
      return {
        domain: normalized,
        verdict: 'block',
        category: blockedCategory,
        reason: 'blocklist',
        latency_ms: Date.now() - start,
      };
    }
  }

  // Step 5: check hardcoded allowlist
  if (HARDCODED_ALLOWLIST.has(normalized)) {
    await logEvent(profile, normalized, 'allow', 'safe', start);
    return {
      domain: normalized,
      verdict: 'allow',
      category: 'safe',
      reason: 'allowlist',
      latency_ms: Date.now() - start,
    };
  }

  // Step 6: default allow (freedom-first)
  await logEvent(profile, normalized, 'allow', 'uncategorized', start);
  return {
    domain: normalized,
    verdict: 'allow',
    category: 'uncategorized',
    reason: 'default_allow',
    latency_ms: Date.now() - start,
  };
}

async function logEvent(
  profile: any,
  domain: string,
  verdict: Verdict,
  category: string | null,
  start: number
) {
  try {
    await db.query(
      `INSERT INTO dns_events 
        (device_id, child_profile_id, domain, verdict, category, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        profile.device_id,
        profile.child_profile_id,
        domain,
        verdict,
        category,
        Date.now() - start,
      ]
    );
  } catch (err) {
    console.error('Failed to log DNS event:', err);
  }
}