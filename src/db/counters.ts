import { db } from '../db/connection';

/**
 * Increment the block counter for a given child + category.
 * One row per (child_profile_id, day, category). No domains stored.
 *
 * This replaces dns_events for blocks. Privacy-minimal: aggregated counts only.
 */
export async function incrementBlockCounter(
  childProfileId: string,
  category: string
): Promise<void> {
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
