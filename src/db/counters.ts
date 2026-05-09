import { db } from '../db/connection';
import { isBoxMode } from '../mode';
import { recordBlock as recordBlockToBoxQueue } from '../box/block-reporter';

/**
 * Increment the block counter for a given child + category.
 *
 * Mode-aware:
 *   - api mode: writes directly to PG block_counters (legacy path,
 *               still used by the cloud-side resolver tests + any
 *               direct /api/v1/resolve callers).
 *   - box mode: enqueues to the in-memory block-reporter queue
 *               (src/box/block-reporter.ts), which batches up and
 *               flushes to POST /api/v1/box/blocks every 30s.
 *
 * Both paths are fire-and-forget: a counter failure must never break
 * a DNS query.
 */
export async function incrementBlockCounter(
  childProfileId: string,
  category: string,
): Promise<void> {
  if (isBoxMode()) {
    try {
      recordBlockToBoxQueue(childProfileId, category);
    } catch (err) {
      console.error('[counters] box-queue enqueue failed:', err);
    }
    return;
  }
  try {
    await db.query(
      `
      INSERT INTO block_counters (child_profile_id, day, category, count)
      VALUES ($1, CURRENT_DATE, $2, 1)
      ON CONFLICT (child_profile_id, day, category)
      DO UPDATE SET count = block_counters.count + 1;
      `,
      [childProfileId, category]
    );
  } catch (err) {
    // Counter increment failures should never break the resolver path.
    console.error('Block counter increment failed:', err);
  }
}

/**
 * Sum of all blocks for a child on a given day. Optionally filter by category.
 */
export async function getDailyBlockCount(
  childProfileId: string,
  day: Date,
  category?: string
): Promise<number> {
  const params: any[] = [childProfileId, day];
  let where = `child_profile_id = $1 AND day = $2`;
  if (category) {
    params.push(category);
    where += ` AND category = $3`;
  }

  const result = await db.query(
    `SELECT COALESCE(SUM(count), 0)::int AS total FROM block_counters WHERE ${where};`,
    params
  );
  return result.rows[0]?.total ?? 0;
}

/**
 * All-time totals for a child, grouped by category.
 */
export async function getTotalsByCategory(
  childProfileId: string
): Promise<Record<string, number>> {
  const result = await db.query(
    `
    SELECT category, COALESCE(SUM(count), 0)::int AS total
    FROM block_counters
    WHERE child_profile_id = $1
    GROUP BY category;
    `,
    [childProfileId]
  );
  const out: Record<string, number> = {};
  for (const row of result.rows) {
    out[row.category] = row.total;
  }
  return out;
}
