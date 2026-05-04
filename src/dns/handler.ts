import * as dnsPacket from 'dns-packet';
import { getBlockCategory } from '../cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import { forwardUpstream } from './upstream';

/**
 * Unified DNS query handler.
 *
 * Same filtering logic is used by both:
 *   - UDP server on port 53 (devices on the LAN)
 *   - DoH endpoint on port 3000 (DoH-capable clients)
 *
 * For each query:
 *   1. Cache check (Redis, keyed by domain)
 *   2. Categorized blocklist check (malware, phishing, doh_bypass, adult)
 *   3. Forward to upstream if allowed
 *
 * Returns a binary DNS response packet ready to send back to the client.
 */
export async function handleDnsQuery(body: Buffer): Promise<Buffer> {
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

  const domain = String(question.name).toLowerCase();
  const blocked = await shouldBlock(domain);

  if (blocked) {
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

async function shouldBlock(domain: string): Promise<boolean> {
  const cached = await getCachedVerdict('global', domain);
  if (cached !== null && cached !== undefined) {
    return cached === 'block';
  }

  const category = await getBlockCategory(domain);
  if (category) {
    await setCachedVerdict('global', domain, 'block', 21600);
    return true;
  }

  await setCachedVerdict('global', domain, 'allow', 86400);
  return false;
}
