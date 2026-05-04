import fetch from 'node-fetch';
import { INTEL_SOURCES, IntelSource, REFRESH_INTERVAL_MINUTES } from './sources';
import { DOH_BYPASS_DOMAINS } from './doh-endpoints';
import { replaceCategory, getCategorySize, CATEGORIES } from '../cache/blocklist';

/**
 * Threat intelligence updater.
 *
 * - Loads the static DoH bypass list immediately.
 * - Fetches each remote feed, parses by format, replaces the category in
 *   Redis atomically.
 * - Failures are logged but never crash the resolver — old data stays in
 *   Redis if a fetch fails, which is the right tradeoff (stale > empty).
 * - Runs once on boot, then on REFRESH_INTERVAL_MINUTES.
 */

let timer: NodeJS.Timeout | null = null;

export async function runUpdate(): Promise<void> {
  console.log('[intel] starting refresh...');
  const startedAt = Date.now();

  // 1. Static lists first — these don't fail.
  try {
    const count = await replaceCategory('doh_bypass', DOH_BYPASS_DOMAINS);
    console.log(`[intel] doh_bypass: ${count} domains`);
  } catch (err) {
    console.error('[intel] doh_bypass update failed:', err);
  }

  // 2. Remote feeds in parallel. Each one independent — one failure
  //    doesn't poison the others.
  const results = await Promise.allSettled(
    INTEL_SOURCES.map((src) => fetchAndStore(src))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const src = INTEL_SOURCES[i];
    if (r.status === 'rejected') {
      console.error(`[intel] ${src.name} (${src.category}) failed:`, r.reason);
    }
  }

  // 3. Summary of all categories.
  const sizes: string[] = [];
  for (const cat of CATEGORIES) {
    const size = await getCategorySize(cat);
    sizes.push(`${cat}=${size}`);
  }
  const elapsed = Date.now() - startedAt;
  console.log(`[intel] refresh complete in ${elapsed}ms: ${sizes.join(', ')}`);
}

async function fetchAndStore(src: IntelSource): Promise<void> {
  const response = await fetch(src.url, {
    // 30s — these files can be a few MB.
    signal: AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'Meadow-Intel/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${src.url}`);
  }

  const text = await response.text();
  const domains = parseFeed(text, src.format);

  if (domains.length === 0) {
    throw new Error(`empty feed from ${src.url}`);
  }

  const count = await replaceCategory(src.category, domains);
  console.log(`[intel] ${src.name} → ${src.category}: ${count} domains`);
}

export function parseFeed(text: string, format: 'hosts' | 'domains'): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;

    if (format === 'hosts') {
      // "0.0.0.0 evil.com" or "127.0.0.1 evil.com"
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const ip = parts[0];
      const domain = parts[1].toLowerCase();
      if (ip !== '0.0.0.0' && ip !== '127.0.0.1') continue;
      if (isValidDomain(domain)) out.push(domain);
    } else {
      // One domain per line.
      const domain = line.split(/\s+/)[0].toLowerCase();
      if (isValidDomain(domain)) out.push(domain);
    }
  }
  return out;
}

function isValidDomain(d: string): boolean {
  if (!d || d.length > 253) return false;
  if (d === 'localhost' || d === 'broadcasthost') return false;
  // Reject IPs and obvious garbage.
  if (/^[\d.]+$/.test(d)) return false;
  if (!/^[a-z0-9.-]+$/.test(d)) return false;
  if (!d.includes('.')) return false;
  return true;
}

/**
 * Start the periodic refresh. Runs once immediately, then every
 * REFRESH_INTERVAL_MINUTES.
 */
export function startScheduler(): void {
  if (timer) return;
  if (process.env.DISABLE_SCHEDULER === '1') {
    console.log('[intel] scheduler disabled (DISABLE_SCHEDULER=1)');
    return;
  }

  // Run once at startup, but don't block boot.
  runUpdate().catch((err) => {
    console.error('[intel] initial refresh failed:', err);
  });

  const ms = REFRESH_INTERVAL_MINUTES * 60 * 1000;
  timer = setInterval(() => {
    runUpdate().catch((err) => {
      console.error('[intel] scheduled refresh failed:', err);
    });
  }, ms);

  console.log(
    `[intel] scheduler started — refreshing every ${REFRESH_INTERVAL_MINUTES} minutes`
  );
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
