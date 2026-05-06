import { db } from './connection';

/**
 * Migration 009: Box network mode reporting.
 *
 * Adds devices.network_status JSONB. The box pushes its current
 * DHCP-handoff state via POST /api/v1/box/network-status; the
 * dashboard reads it back via GET endpoints. Stored as an opaque
 * JSON blob so we can extend the contract without follow-up
 * migrations.
 *
 * Run with: npx ts-node src/db/migrate-009.ts
 */
async function migrate() {
  console.log('Running migration 009 (box network status)...');

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS network_status JSONB;
  `);
  console.log('Added devices.network_status.');

  console.log('Migration 009 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 009 failed:', err);
    process.exit(1);
  });
}
