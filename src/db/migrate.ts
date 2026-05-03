import { db } from './connection';

/**
 * Initial migration. Privacy-minimal schema:
 *  - No age field on child profiles, just a tier.
 *  - No URL/domain logging. block_counters table holds aggregated counts only.
 */
async function migrate() {
  console.log('Running migrations...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS families (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS child_profiles (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id),
      name TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'standard'
        CHECK (tier IN ('strict', 'standard', 'light')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id),
      child_profile_id UUID REFERENCES child_profiles(id),
      platform TEXT NOT NULL,
      device_token TEXT NOT NULL UNIQUE,
      last_seen TIMESTAMPTZ
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS filter_policies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      child_profile_id UUID NOT NULL REFERENCES child_profiles(id),
      blocked_categories JSONB NOT NULL DEFAULT '[]',
      allowed_domains JSONB NOT NULL DEFAULT '[]',
      blocked_domains JSONB NOT NULL DEFAULT '[]',
      safe_search_enforce BOOLEAN NOT NULL DEFAULT true,
      youtube_restrict BOOLEAN NOT NULL DEFAULT true
    );
  `);

  // Aggregated block counters. One row per child per day per category.
  // No domains, no URLs, no per-event detail.
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

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_block_counters_child_day
    ON block_counters (child_profile_id, day DESC);
  `);

  console.log('All tables created successfully.');
  await db.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
