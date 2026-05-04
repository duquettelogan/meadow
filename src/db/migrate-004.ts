import { db } from './connection';

/**
 * Migration 004: Device pairing flow.
 *
 * Replaces the developer-facing "generate API key" UI with a real pairing
 * flow that doesn't expose keys to parents.
 *
 * Flow:
 *  1. Device hits /api/v1/pairing/start with its hardware_id, gets a code.
 *  2. Parent enters the code in the dashboard (/api/v1/pairing/claim),
 *     selecting which child the device belongs to.
 *  3. Device polls /api/v1/pairing/poll with code + hardware_id and
 *     receives the API key once the parent has claimed.
 *
 * Run with: npx ts-node src/db/migrate-004.ts
 */
async function migrate() {
  console.log('Running migration 004 (pairing)...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL UNIQUE,
      hardware_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,

      -- Set when a parent claims the code in the dashboard.
      claimed_at TIMESTAMPTZ,
      claimed_by_parent_id UUID REFERENCES parents(id),
      device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
      api_key_id UUID REFERENCES api_keys(id) ON DELETE CASCADE,

      -- Plaintext API key, stored only between claim and first poll.
      -- Cleared as soon as the device retrieves it. NEVER persists long-term.
      plaintext_key TEXT,

      -- Set when the device successfully retrieves the key. After that,
      -- the row should be deleted on the next access.
      api_key_revealed_at TIMESTAMPTZ
    );
  `);
  console.log('Created pairing_codes table.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_code
    ON pairing_codes (code) WHERE claimed_at IS NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires
    ON pairing_codes (expires_at) WHERE claimed_at IS NULL;
  `);

  console.log('Migration 004 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 004 failed:', err);
    process.exit(1);
  });
}
