import { db } from './connection';

/**
 * Migration 003: Authentication tables.
 *
 * Adds:
 *  - parents: email + bcrypt password_hash, FK to family
 *  - api_keys: device-side API keys (HMAC-hashed), prefix-indexed
 *
 * Run with: npx ts-node src/db/migrate-003.ts
 */
async function migrate() {
  console.log('Running migration 003 (auth)...');

  // Parents — one or more per family. Email is unique globally.
  await db.query(`
    CREATE TABLE IF NOT EXISTS parents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
  `);
  console.log('Created parents table.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_parents_family
    ON parents (family_id);
  `);

  // Device API keys — HMAC-hashed, prefix-indexed for fast lookup.
  // We store key_prefix (first 8 chars of plaintext) for the lookup,
  // then verify the full key against key_hash with constant-time compare.
  await db.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ
    );
  `);
  console.log('Created api_keys table.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix
    ON api_keys (key_prefix) WHERE revoked_at IS NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_device
    ON api_keys (device_id);
  `);

  console.log('Migration 003 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 003 failed:', err);
    process.exit(1);
  });
}
