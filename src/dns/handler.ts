import * as dnsPacket from 'dns-packet';
import { getBlockCategory } from '../cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import { forwardUpstream } from './upstream';
import { incrementBlockCounter } from '../db/counters';
import { isCrisisDomain } from '../intel/crisis-floor';

/**
 * Unified DNS query handler.
 *
 * Same filtering logic is used by both:
 *   - UDP server on port 53 (devices on the LAN)
 *   - DoH endpoint on port 3000 (DoH-capable clients)
 *
 * Pipeline:
 *   0. Crisis floor (hard allow, no log, no counter, no cache)
 *   1. Cache check (Redis, keyed by domain)
 *   2. Categorized blocklist check (malware, phishing, doh_bypass, adult)
 *   3. Forward to upstream if allowed
 *
 * If `options.childProfileId` is supplied, blocked queries also fire a
 * fire-and-forget block_counters increment. The UDP server passes the
 * box's resolved child_profile_id; DoH currently doesn't (TODO).
 *
 * Returns a binary DNS response packet ready to send back to the client.
 */
export interface HandleDnsOptions {
  childProfileId?: string | null;
}

export async function handleDnsQuery(
  body: Buffer,
  options: HandleDnsOptions = {},
): Promise<Buffer> {
  let query: dnsPacket.Packet;
  try {
    query = dnsPacket.decode(body);
  } catch (err) {
    // Malformed packet — return SERVFAIL.
    return dnsPacket.encode({
      type: 'response',
      id: 0,
      flags: dnsPacket.RECURSION_DESIRED | 2 /* SERVFAIL */,
      questions: [],
      answers: [],
    });
  }

  const question = query.questions?.[0];
  if (!question) {
    return dnsPacket.encode({
      type: 'response',
      id: query.id,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: query.questions,
      answers: [],
    });
  }

  const domain = String(question.name).toLowerCase().replace(/\.$/, '');

  // ---------------------------------------------------------------
  // Crisis floor — checked FIRST, ahead of cache, blocklists, and
  // counters. Any match here:
  //   - is forwarded upstream as a normal allow
  //   - leaves NO record in our cache (nothing for an admin to grep)
  //   - never increments block_counters
  //   - never produces a log line that names the domain
  // This is a deliberate privacy commitment, not a perf optimization.
  // Do not "tidy this up" by folding it into classifyDomain().
  // ---------------------------------------------------------------
  if (isCrisisDomain(domain)) {
    try {
      return await forwardUpstream(body);
    } catch {
      // Generic failure path — explicitly do NOT log the err object
      // because Node DNS errors often embed the hostname.
      return dnsPacket.encode({
        type: 'response',
        id: query.id,
        flags: dnsPacket.RECURSION_DESIRED | 2,
        questions: query.questions,
        answers: [],
      });
    }
  }

  const verdict = await classifyDomain(domain);

  if (verdict.blocked) {
    // Fire-and-forget counter increment. Never blocks the DNS response.
    if (options.childProfileId) {
      incrementBlockCounter(
        options.childProfileId,
        verdict.category ?? 'unknown',
      ).catch((err) => {
        console.error('[dns] block counter increment failed:', err);
      });
    }

    return dnsPacket.encode({
      type: 'response',
      id: query.id,
      flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
      questions: query.questions,
      answers: [
        {
          type: 'A',
          name: domain,
          ttl: 300,
          // Sinkhole: 0.0.0.0 means "no route." Some clients prefer
          // NXDOMAIN — we can switch later if it causes app misbehavior.
          data: '0.0.0.0',
        },
      ],
    });
  }

  // Forward to upstream — the upstream module handles UDP/TCP/DoH internally.
  try {
    return await forwardUpstream(body);
  } catch (err) {
    console.error('[dns] upstream forwarding failed:', err);
    // Return SERVFAIL on upstream failure rather than nothing.
    return dnsPacket.encode({
      type: 'response',
      id: query.id,
      flags: dnsPacket.RECURSION_DESIRED | 2,
      questions: query.questions,
      answers: [],
    });
  }
}

interface Verdict {
  blocked: boolean;
  category: string | null;
}

/**
 * Decide whether to block + which category. Cache stores either:
 *   - "allow"
 *   - "block:<category>"   (new format, includes category for counter)
 *   - "block"              (legacy format from earlier deploys, treated as 'unknown')
 *
 * On cache miss, look up the category from the blocklists and write
 * back to cache with the new format.
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

  // Cache miss — hit the blocklists.
  const category = await getBlockCategory(domain);
  if (category) {
    await setCachedVerdict('global', domain, `block:${category}`, 21600);
    return { blocked: true, category };
  }

  await setCachedVerdict('global', domain, 'allow', 86400);
  return { blocked: false, category: null };
}
