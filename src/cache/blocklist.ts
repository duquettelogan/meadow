import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Categorized blocklists in Redis.
 *
 * One Redis set per category, keyed as `meadow:blocklist:<category>`.
 *
 * Lookups:
 *  - getBlockCategory(domain) — returns the first matching category, or null
 *  - isBlocked(domain) — kept for backward compatibility, just !!getBlockCategory
 *
 * Population happens in src/intel/updater.ts and at boot via loadBlocklist().
 */

const KEY_PREFIX = 'meadow:blocklist:';

// Categories the resolver checks, in priority order. The first match wins
// when reporting which category caused the block.
export const CATEGORIES = ['malware', 'phishing', 'doh_bypass', 'adult'];

function key(category: string): string {
  return `${KEY_PREFIX}${category}`;
}

function getClient() {
  const client = createClient({
    url: process.env.REDIS_URL,
  });
  client.on('error', (err) => console.error('Redis error:', err));
  return client;
}

/**
 * Replace a category's blocklist with a new set of domains atomically.
 * Uses a temp key + RENAME so resolver lookups are never empty mid-update.
 */
export async function replaceCategory(
  category: string,
  domains: string[]
): Promise<number> {
  const client = getClient();
  await client.connect();
  try {
    const finalKey = key(category);
    const tempKey = `${finalKey}:tmp:${Date.now()}`;

    if (domains.length === 0) {
      await client.del(finalKey);
      return 0;
    }

    const CHUNK = 5000;
    const lower = domains.map((d) => d.toLowerCase());
    for (let i = 0; i < lower.length; i += CHUNK) {
      await client.sAdd(tempKey, lower.slice(i, i + CHUNK));
    }

    await client.rename(tempKey, finalKey);
    return await client.sCard(finalKey);
  } finally {
    await client.disconnect();
  }
}

/**
 * Returns the first category that contains the domain, or null.
 * Checks parent domains too — a block on "evil.com" also blocks "x.evil.com".
 */
export async function getBlockCategory(
  domain: string
): Promise<string | null> {
  const client = getClient();
  await client.connect();
  try {
    const candidates = parentDomains(domain.toLowerCase());

    for (const category of CATEGORIES) {
      const setKey = key(category);
      // Check the exact domain and all parent suffixes.
      for (const candidate of candidates) {
        const member = await client.sIsMember(setKey, candidate);
        if (member === 1) return category;
      }
    }
    return null;
  } finally {
    await client.disconnect();
  }
}

export async function isBlocked(domain: string): Promise<boolean> {
  return (await getBlockCategory(domain)) !== null;
}

export async function getCategorySize(category: string): Promise<number> {
  const client = getClient();
  await client.connect();
  try {
    return await client.sCard(key(category));
  } finally {
    await client.disconnect();
  }
}

/**
 * Boot-time helper. Returns the total domains across all categories.
 * If categories are already populated, this is a no-op (the updater handles
 * refreshes).
 */
export async function loadBlocklist(): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    let total = 0;
    for (const category of CATEGORIES) {
      total += await client.sCard(key(category));
    }
    if (total > 0) {
      console.log(`Blocklists loaded (${total} domains across ${CATEGORIES.length} categories).`);
    } else {
      console.log('Blocklists empty — updater will populate on first run.');
    }
  } finally {
    await client.disconnect();
  }
}

/**
 * Generate domain + parent suffixes for matching.
 * "a.b.evil.com" → ["a.b.evil.com", "b.evil.com", "evil.com"]
 * Stops at TLD (won't match just ".com").
 */
function parentDomains(domain: string): string[] {
  const parts = domain.split('.');
  const out: string[] = [];
  // Need at least 2 labels for it to be a valid domain.
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join('.'));
  }
  return out;
}
