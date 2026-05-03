import { db } from './connection';

/**
 * Migration 002: Privacy-minimal schema changes.
 *
 * Changes:
 *  1. Drop dns_events table (URL logging) — replaced with block_counters.
 *  2. Add block_counters table — aggregated counts only, no URLs.
 *  3. Remove `age` column from child_profiles — replaced with `tier`.
 *  4. Drop redundant `protection_level` column (use `tier` instead).
 *
 * Run with: npx ts-node src/db/migrate-002.ts
 */
async function migrate() {
  console.log('Running migration 002...');

  // 1. Drop dns_events table — we don't log per-request URLs anymore.
  await db.query(`DROP TABLE IF EXISTS dns_events;`);
  console.log('Dropped dns_events.');

  // 2. Create block_counters table — aggregated counts only.
  //    One row per child profile per day per category.
  //    No domains, no URLs, no per-request data.
  await db.query(`
    CREATE TABLE IF NOT EXISTS block_counters (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      child_profile_id UUID NOT NULL REFERENCES child_profiles(id) ON DELETE CASCADE,
      day DATE NOT NULL,
      category TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      UNIQUE (child_profile_id, day, category)
    );
  `);
  console.log('Created block_counters.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_block_counters_child_day
    ON block_counters (child_profile_id, day DESC);
  `);

  // 3. Remove age field — Logan doesn't want age framing.
  //    Add a tier column instead: 'strict' | 'standard' | 'light'.
  await db.query(`
    ALTER TABLE child_profiles
    DROP COLUMN IF EXISTS age;
  `);
  console.log('Dropped age column.');

  await db.query(`
    ALTER TABLE child_profiles
    ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'standard'
    CHECK (tier IN ('strict', 'standard', 'light'));
  `);
  console.log('Added tier column.');

  // 4. Drop the redundant protection_level column (use tier instead).
  await db.query(`
    ALTER TABLE child_profiles
    DROP COLUMN IF EXISTS protection_level;
  `);
  console.log('Dropped protection_level column.');

  console.log('Migration 002 complete.');
  await db.end();
}

migrate().catch((err) => {
  console.error('Migration 002 failed:', err);
  process.exit(1);
});
