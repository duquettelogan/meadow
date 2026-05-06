import * as dnsPacket from 'dns-packet';
import { getBlockCategory } from '../cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import { forwardUpstream } from './upstream';
import { incrementBlockCounter } from '../db/counters';
import { isCrisisDomain } from '../intel/crisis-floor';
import { isCaptivePortalDomain } from '../intel/captive-portal-allowlist';
import { FilterPolicy, matchesDomainList } from '../policies/loader';

/**
 * Unified DNS query handler.
 *
 * Same filtering logic is used by both:
 *   - UDP server on port 53 (devices on the LAN)
 *   - DoH endpoint on port 3000 (DoH-capable clients)
 *
 * Pipeline (top to bottom; first match wins):
 *   0. Crisis floor          — hard allow, no log, no counter, no cache
 *   1. Non-A/AAAA pass-through — we don't filter MX/TXT/SRV/etc
 *   2. Captive portal allow  — keep wifi probes working
 *   3. Parent allow list     — explicit user permission overrides everything below
 *   4. Parent block list     — explicit user denial
 *   5. Safe-search rewrite   — CNAME google/bing/ddg to safe variants
 *   6. YouTube restrict      — CNAME youtube to restrictmoderate
 *   7. Categorized blocklist — Redis-backed (malware/phishing/doh_bypass/adult)
 *   8. Forward upstream
 *
 * Steps 3-6 require an `options.policy` value. The UDP server passes the
 * box's resolved per-child policy; DoH currently does not (TODO: Phase 4.1
 * adds DoH auth, then DoH can carry policy too).
 *
 * If `options.childProfileId` is supplied, blocked queries fire a
 * fire-and-forget block_counters increment.
 */
export interface HandleDnsOptions {
  childProfileId?: string | null;
  policy?: FilterPolicy | null;
}

const SUPPORTED_QUERY_TYPES = new Set(['A', 'AAAA']);

// Search-engine safe-search rewrites. The client receives a CNAME and
// follows up with a normal lookup for the target, which we let through
// unaltered. This is the same approach Pi-hole uses.
const SAFE_SEARCH_REWRITES: Record<string, string> = {
  // Google
  'google.com': 'forcesafesearch.google.com',
  'www.google.com': 'forcesafesearch.google.com',
  // Bing
  'bing.com': 'strict.bing.com',
  'www.bing.com': 'strict.bing.com',
  // DuckDuckGo
  'duckduckgo.com': 'safe.duckduckgo.com',
  'www.duckduckgo.com': 'safe.duckduckgo.com',
  // Yandex
  'yandex.com': 'familysearch.yandex.com',
  'www.yandex.com': 'familysearch.yandex.com',
};

// Catch the dozens of Google ccTLDs (.co.uk, .de, .fr, etc.) without
// listing each one individually.
const GOOGLE_CCTLD_RE = /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/i;

const YOUTUBE_REWRITES: Record<string, string> = {
  'youtube.com': 'restrictmoderate.youtube.com',
  'www.youtube.com': 'restrictmoderate.youtube.com',
  'm.youtube.com': 'restrictmoderate.youtube.com',
  'youtubei.googleapis.com': 'restrictmoderate.youtube.com',
  'youtube.googleapis.com': 'restrictmoderate.youtube.com',
};

export async function handleDnsQuery(
  body: Buffer,
  options: HandleDnsOptions = {},
): Promise<Buffer> {
  let query: dnsPacket.Packet;
  try {
    query = dnsPacket.decode(body);
  } catch {
    return servfail(0, []);
  }

  const question = query.questions?.[0];
  if (!question) {
    return emptyResponse(query);
  }

  const qtype = String(question.type).toUpperCase();
  const domain = String(question.name).toLowerCase().replace(/\.$/, '');

  // ---------------------------------------------------------------
  // 0. Crisis floor — checked FIRST, ahead of every other rule.
  // Any match here:
  //   - is forwarded upstream as a normal allow
  //   - leaves NO record in our cache (nothing for an admin to grep)
  //   - never increments block_counters
  //   - never produces a log line that names the domain
  // This is a deliberate privacy commitment, not a perf optimization.
  // Do not "tidy this up" by folding it into classifyDomain().
  // ---------------------------------------------------------------
  if (isCrisisDomain(domain)) {
    return upstreamSilent(body, query);
  }

  // 1. Non-A/AAAA queries pass through unfiltered. We only sinkhole
  //    address lookups; MX/TXT/SRV/HTTPS/etc. go upstream as-is.
  if (!SUPPORTED_QUERY_TYPES.has(qtype)) {
    return upstream(body, query);
  }

  // 2. Captive portal allow — needed so phones don't decide the wifi
  //    is broken. Logged like any other allow; not privacy-sensitive.
  if (isCaptivePortalDomain(domain)) {
    return upstream(body, query);
  }

  const policy = options.policy ?? null;

  // 3. Parent allow list. Explicit user permission overrides safe-search,
  //    YouTube restrict, and category blocks. Suffix-matching, so an entry
  //    of "roblox.com" also allows assets.rbxcdn.com? No — only entries
  //    rooted at *that* domain. assets.roblox.com would be allowed.
  if (policy && matchesDomainList(domain, policy.allowed_domains)) {
    return upstream(body, query);
  }

  // 4. Parent block list. Explicit user denial; wins over upstream allow.
  if (policy && matchesDomainList(domain, policy.blocked_domains)) {
    fireCounter(options.childProfileId, 'parent_block');
    return sinkhole(query, qtype, domain);
  }

  // 5. Safe-search rewrites. Only fire if (a) the policy says so and
  //    (b) the parent hasn't explicitly allowed/blocked this domain
  //    (handled above).
  if (policy && policy.safe_search_enforce) {
    const target = safeSearchTarget(domain);
    if (target) return cnameResponse(query, domain, target);
  }

  // 6. YouTube Restricted Mode rewrite.
  if (policy && policy.youtube_restrict) {
    const target = youtubeTarget(domain);
    if (target) return cnameResponse(query, domain, target);
  }

  // 7. Categorized blocklist (cached in Redis, backed by intel feeds).
  //    If Redis or the blocklist lookup throws (e.g. Redis restart in
  //    progress), we degrade to "no category info" and forward upstream
  //    rather than wedging DNS for the whole network. Crisis floor and
  //    parent rules above us still apply because they're in-process.
  let verdict: Verdict = { blocked: false, category: null };
  try {
    verdict = await classifyDomain(domain);
  } catch (err) {
    console.error('[dns] classifyDomain failed (degrading to allow):', err);
  }
  if (verdict.blocked) {
    fireCounter(options.childProfileId, verdict.category ?? 'unknown');
    return sinkhole(query, qtype, domain);
  }

  // 8. Default: forward upstream.
  return upstream(body, query);
}

// ---------- helpers ----------

function fireCounter(
  childProfileId: string | null | undefined,
  category: string,
): void {
  if (!childProfileId) return;
  incrementBlockCounter(childProfileId, category).catch((err) => {
    console.error('[dns] block counter increment failed:', err);
  });
}

function sinkhole(
  query: dnsPacket.Packet,
  qtype: string,
  domain: string,
): Buffer {
  // 0.0.0.0 / :: signals "no route." Some clients prefer NXDOMAIN, but
  // sinkhole IPs let block pages and sentinel checks (this domain went
  // to nothing) keep working.
  const answer =
    qtype === 'AAAA'
      ? { type: 'AAAA' as const, name: domain, ttl: 300, data: '::' }
      : { type: 'A' as const, name: domain, ttl: 300, data: '0.0.0.0' };
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
    questions: query.questions,
    answers: [answer],
  });
}

function cnameResponse(
  query: dnsPacket.Packet,
  name: string,
  target: string,
): Buffer {
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
    questions: query.questions,
    answers: [{ type: 'CNAME', name, ttl: 300, data: target }],
  });
}

async function upstream(
  body: Buffer,
  query: dnsPacket.Packet,
): Promise<Buffer> {
  try {
    return await forwardUpstream(body);
  } catch (err) {
    console.error('[dns] upstream forwarding failed:', err);
    return servfail(query.id ?? 0, query.questions ?? []);
  }
}

async function upstreamSilent(
  body: Buffer,
  query: dnsPacket.Packet,
): Promise<Buffer> {
  try {
    return await forwardUpstream(body);
  } catch {
    // Crisis path: explicitly do NOT log err — Node DNS errors often
    // embed the failed hostname in the message, which would defeat
    // the no-trace guarantee.
    return servfail(query.id ?? 0, query.questions ?? []);
  }
}

function servfail(id: number, questions: any[]): Buffer {
  return dnsPacket.encode({
    type: 'response',
    id,
    flags: dnsPacket.RECURSION_DESIRED | 2 /* SERVFAIL */,
    questions,
    answers: [],
  });
}

function emptyResponse(query: dnsPacket.Packet): Buffer {
  return dnsPacket.encode({
    type: 'response',
    id: query.id,
    flags: dnsPacket.RECURSION_DESIRED,
    questions: query.questions,
    answers: [],
  });
}

function safeSearchTarget(domain: string): string | null {
  if (SAFE_SEARCH_REWRITES[domain]) return SAFE_SEARCH_REWRITES[domain];
  if (GOOGLE_CCTLD_RE.test(domain)) return 'forcesafesearch.google.com';
  return null;
}

function youtubeTarget(domain: string): string | null {
  return YOUTUBE_REWRITES[domain] ?? null;
}

interface Verdict {
  blocked: boolean;
  category: string | null;
}

/**
 * Decide whether to block + which category. Cache stores either:
 *   - "allow"
 *   - "block:<category>"   (current format, includes category for counter)
 *   - "block"              (legacy format from earlier deploys, treated as 'unknown')
 *
 * Cache scope is 'global' because category-block decisions are the same
 * for every child. Per-child rules (parent allow/block, safe-search, etc.)
 * are evaluated upstream of this function and never reach the cache.
 */
async function classifyDomain(domain: string): Promise<Verdict> {
  const cached = await getCachedVerdict('global', domain);

  if (cached === 'allow') {
    return { blocked: false, category: null };
  }

  if (typeof cached === 'string' && cached.startsWith('block')) {
    const idx = cached.indexOf(':');
    const category = idx >= 0 ? cached.slice(idx + 1) : 'unknown';
    return { blocked: true, category };
  }

  const category = await getBlockCategory(domain);
  if (category) {
    await setCachedVerdict('global', domain, `block:${category}`, 21600);
    return { blocked: true, category };
  }

  await setCachedVerdict('global', domain, 'allow', 86400);
  return { blocked: false, category: null };
}
