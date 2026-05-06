import { db } from './connection';

/**
 * Migration 008: Household refactor + device discovery.
 *
 * Schema:
 *   1. child_profiles.is_household BOOLEAN NOT NULL DEFAULT false.
 *      A family always has exactly one is_household=true child — created
 *      automatically at signup, hidden from GET /children, target of the
 *      family-scoped /filter-policy endpoints, and the only policy the
 *      DNS resolver uses in v1.
 *
 *   2. devices.hostname / manufacturer / mac (all nullable). Populated
 *      by the box's /devices/discovered POSTs as devices show up on the
 *      LAN.
 *
 *   3. devices UNIQUE (family_id, mac) — supports the upsert in
 *      POST /api/v1/devices/discovered. NULL mac is allowed multiple
 *      times per family (paired boxes don't have a MAC in this column).
 *
 *   4. pairing_codes.family_id — set during /pairing/claim so the
 *      claim record is family-scoped without going through parent →
 *      family lookup.
 *
 * Backfill:
 *   - Every existing family gets a Household child if they don't have
 *     one yet.
 *   - Every Household child gets a default filter_policies row.
 *
 * Run with: npx ts-node src/db/migrate-008.ts
 */
async function migrate() {
  console.log('Running migration 008 (household + device discovery)...');

  await db.query(`
    ALTER TABLE child_profiles
      ADD COLUMN IF NOT EXISTS is_household BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log('Added child_profiles.is_household.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_child_profiles_family_household
      ON child_profiles (family_id) WHERE is_household = true;
  `);

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS hostname TEXT,
      ADD COLUMN IF NOT EXISTS manufacturer TEXT,
      ADD COLUMN IF NOT EXISTS mac TEXT;
  `);
  console.log('Added devices columns: hostname, manufacturer, mac.');

  // Unique on (family_id, mac). Postgres treats NULL ≠ NULL so paired
  // boxes (which keep mac=NULL) coexist freely; only discovered devices
  // with non-null MACs deduplicate.
  await db.query(`
    ALTER TABLE devices
      DROP CONSTRAINT IF EXISTS devices_family_mac_unique;
  `);
  await db.query(`
    ALTER TABLE devices
      ADD CONSTRAINT devices_family_mac_unique UNIQUE (family_id, mac);
  `);
  console.log('Added unique constraint devices(family_id, mac).');

  await db.query(`
    ALTER TABLE pairing_codes
      ADD COLUMN IF NOT EXISTS family_id UUID REFERENCES families(id);
  `);
  console.log('Added pairing_codes.family_id.');

  // Backfill: every existing family gets a Household child if missing.
  await db.query(`
    INSERT INTO child_profiles (family_id, name, tier, is_household)
    SELECT id, 'Household', 'standard', true
    FROM families f
    WHERE NOT EXISTS (
      SELECT 1 FROM child_profiles c
      WHERE c.family_id = f.id AND c.is_household = true
    );
  `);
  console.log('Backfilled Household child profiles.');

  // Backfill: every Household child gets a default filter_policies row.
  await db.query(`
    INSERT INTO filter_policies (child_profile_id)
    SELECT c.id FROM child_profiles c
    WHERE c.is_household = true
      AND NOT EXISTS (
        SELECT 1 FROM filter_policies p WHERE p.child_profile_id = c.id
      );
  `);
  console.log('Backfilled Household filter_policies.');

  console.log('Migration 008 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 008 failed:', err);
    process.exit(1);
  });
}
