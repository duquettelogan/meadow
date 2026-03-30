import { db } from '../db/connection';
import { isBlocked } from '../cache/blocklist';
import { getCachedVerdict, setCachedVerdict } from '../cache/index';
import * as dnsPacket from 'dns-packet';

export async function handleDoH(
  body: Buffer
): Promise<Buffer> {
  try {
    const query = dnsPacket.decode(body);
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

    const domain = question.name.toLowerCase();
    const qtype = question.type;

    const blocked = await shouldBlock(domain);

    if (blocked) {
      return dnsPacket.encode({
        type: 'response',
        id: query.id,
        flags: dnsPacket.RECURSION_DESIRED | dnsPacket.AUTHORITATIVE_ANSWER,
        questions: query.questions,
        answers: [{
          type: 'A',
          name: domain,
          ttl: 300,
          data: '0.0.0.0',
        }],
      });
    }

    const upstream = await forwardToUpstream(body);
    return upstream;

  } catch (err) {
    console.error('DoH error:', err);
    return Buffer.alloc(0);
  }
}

async function shouldBlock(domain: string): Promise<boolean> {
  const cached = await getCachedVerdict('global', domain);
  if (cached) return cached === 'block';

  const blocked = await isBlocked(domain);
  if (blocked) {
    await setCachedVerdict('global', domain, 'block', 21600);
    await logDnsEvent(domain, 'block', 'adult', 'blocklist');
    return true;
  }

  await setCachedVerdict('global', domain, 'allow', 86400);
  return false;
}

async function logDnsEvent(
  domain: string,
  verdict: string,
  category: string,
  reason: string
) {
  try {
    await db.query(
      `INSERT INTO dns_events (domain, verdict, category, reason, resolved_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [domain, verdict, category, reason]
    );
  } catch (err) {
    console.error('Log error:', err);
  }
}

async function forwardToUpstream(query: Buffer): Promise<Buffer> {
  const response = await fetch('https://1.1.1.1/dns-query', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/dns-message',
      'Accept': 'application/dns-message',
    },
    body: new Uint8Array(query),
    signal: AbortSignal.timeout(5000),
  });

  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}