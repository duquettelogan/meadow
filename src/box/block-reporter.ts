/**
 * Box-side block-event reporter.
 *
 * Box-mode boxes have NO database. When the resolver decides to block
 * a query, it calls recordBlock(child_profile_id, category) which
 * appends to an in-memory bucket here. Every BLOCK_FLUSH_INTERVAL_MS
 * (default 30s) we flush the bucket via POST /api/v1/box/blocks to
 * the cloud, which upserts into the real block_counters table.
 *
 * Bucketing key:  ${child_profile_id}:${category}:${hour-bucket}
 *   The hour bucket is the floor of the current time to the hour,
 *   matching the cloud's per-(child × category × day) UPSERT shape:
 *   even at 60-events-per-second per category, an hourly key keeps
 *   the in-memory map tiny.
 *
 * Failure handling:
 *   - On a successful flush, the queue clears the flushed entries.
 *   - On a failed flush, entries are retained and merged with new
 *     events. Hard cap of MAX_BUCKETS (10,000) to bound memory; if
 *     we cross it, drop the OLDEST buckets and log a warning. This
 *     puts a ceiling on what an extended outage can pin down.
 *
 * Disabling: BLOCK_REPORTER_DISABLED=1 (set in tests/setup.ts).
 *
 * recordBlock() is called from the resolver hot path; it must be
 * sync + non-blocking. flush() is async and runs from the timer or
 * test-driven harness.
 */

const HOUR_MS = 60 * 60 * 1000;
const MAX_BUCKETS = 10_000;

const FLUSH_INTERVAL_MS = parseInt(
  process.env.BLOCK_FLUSH_INTERVAL_MS ?? '30000',
  10,
);
const apiUrl = () => process.env.API_URL || 'https://meadow-api-prod.fly.dev';

interface Bucket {
  child_profile_id: string;
  category: string;
  hour_bucket_ms: number; // floor(timestamp / HOUR_MS) * HOUR_MS
  count: number;
  first_seen_at: number; // ms epoch
  last_seen_at: number; // ms epoch
}

const queue = new Map<string, Bucket>();
let timer: NodeJS.Timeout | null = null;

/**
 * Reference to the box's api_key. Caller (src/index.ts main()) sets
 * this after loadBoxContext succeeds. Kept as a getter (a function)
 * rather than a snapshot so a mid-process re-pair (api_key rotation)
 * picks up the new key on the next flush.
 */
let apiKeyGetter: () => string | null = () => null;

export function setApiKeyGetter(fn: () => string | null): void {
  apiKeyGetter = fn;
}

function bucketKey(
  child_profile_id: string,
  category: string,
  hour_ms: number,
): string {
  return `${child_profile_id}:${category}:${hour_ms}`;
}

/**
 * Record a single block event. Sync, non-blocking. Safe to call from
 * any code path; flush happens later on the timer.
 */
export function recordBlock(
  child_profile_id: string,
  category: string,
  whenMs: number = Date.now(),
): void {
  const hour_bucket_ms = Math.floor(whenMs / HOUR_MS) * HOUR_MS;
  const key = bucketKey(child_profile_id, category, hour_bucket_ms);
  const existing = queue.get(key);
  if (existing) {
    existing.count += 1;
    if (whenMs < existing.first_seen_at) existing.first_seen_at = whenMs;
    if (whenMs > existing.last_seen_at) existing.last_seen_at = whenMs;
    return;
  }
  queue.set(key, {
    child_profile_id,
    category,
    hour_bucket_ms,
    count: 1,
    first_seen_at: whenMs,
    last_seen_at: whenMs,
  });
  // Hard cap: drop the oldest bucket if we cross MAX_BUCKETS so an
  // extended outage can't grow this map without bound. Map's
  // insertion-order iteration makes "oldest first" cheap.
  if (queue.size > MAX_BUCKETS) {
    const oldestKey = queue.keys().next().value;
    if (oldestKey) {
      queue.delete(oldestKey);
      console.warn(
        `[block-reporter] queue cap (${MAX_BUCKETS}) crossed — dropped oldest bucket ${oldestKey}`,
      );
    }
  }
}

/**
 * One-shot flush of the queue to the cloud. Exported so tests can
 * drive it deterministically. Returns the number of buckets accepted
 * by the server (0 on failure, with the queue intact for retry).
 */
export async function flushOnce(): Promise<number> {
  if (queue.size === 0) return 0;
  const apiKey = apiKeyGetter();
  if (!apiKey) {
    console.warn('[block-reporter] no api_key yet — deferring flush');
    return 0;
  }

  // Snapshot the queue (we keep the entries in case the flush fails;
  // they'll be merged with anything that arrives during the flight).
  // Deep-copy each bucket — Map.values() returns references, so a
  // recordBlock() mid-flight would otherwise mutate our snapshot too,
  // and the post-flush "subtract what we sent" math wouldn't work.
  const snapshot: Bucket[] = Array.from(queue.values()).map((b) => ({ ...b }));

  const events = snapshot.map((b) => ({
    child_profile_id: b.child_profile_id,
    category: b.category,
    count: b.count,
    first_seen_at: new Date(b.first_seen_at).toISOString(),
    last_seen_at: new Date(b.last_seen_at).toISOString(),
  }));

  let res: Response;
  try {
    res = await fetch(`${apiUrl().replace(/\/$/, '')}/api/v1/box/blocks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ events }),
    });
  } catch (err) {
    console.warn(
      '[block-reporter] flush failed (network):',
      (err as Error).message,
    );
    return 0;
  }

  if (res.status === 401) {
    console.error(
      '[block-reporter] /box/blocks 401 — api_key revoked? holding queue',
    );
    return 0;
  }
  if (!res.ok) {
    console.warn(`[block-reporter] /box/blocks returned ${res.status}`);
    return 0;
  }

  // Success — clear the snapshot's keys from the queue. Anything that
  // got recorded DURING the flush stays in the queue for the next
  // tick.
  for (const b of snapshot) {
    const key = bucketKey(b.child_profile_id, b.category, b.hour_bucket_ms);
    const live = queue.get(key);
    if (!live) continue;
    if (
      live.count === b.count &&
      live.first_seen_at === b.first_seen_at &&
      live.last_seen_at === b.last_seen_at
    ) {
      // Untouched during the flight — safe to delete entirely.
      queue.delete(key);
    } else {
      // Got more events while in flight; subtract what we sent and
      // keep the delta for the next flush.
      live.count -= b.count;
      if (live.count <= 0) queue.delete(key);
    }
  }
  return snapshot.length;
}

export function startBlockReporter(): void {
  if (timer) return;
  if (process.env.BLOCK_REPORTER_DISABLED === '1') {
    console.log('[block-reporter] disabled (BLOCK_REPORTER_DISABLED=1)');
    return;
  }
  timer = setInterval(() => {
    void flushOnce().catch((err) => {
      console.error('[block-reporter] tick threw:', (err as Error).message);
    });
  }, FLUSH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(
    `[block-reporter] started — flush every ${Math.floor(FLUSH_INTERVAL_MS / 1000)}s`,
  );
}

export function stopBlockReporter(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Test helper. Don't call in production.
 */
export function _resetBlockReporterForTests(): void {
  queue.clear();
  apiKeyGetter = () => null;
}

export function _queueSizeForTests(): number {
  return queue.size;
}
