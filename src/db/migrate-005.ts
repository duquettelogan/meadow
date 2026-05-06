import { db } from './connection';

/**
 * Migration 005: Device health payload.
 *
 * Adds last_health_payload JSONB to devices for the heartbeat endpoint.
 * The heartbeat updates last_seen + writes the latest health snapshot
 * so the parent dashboard can show "last seen 2 min ago" plus uptime,
 * blocklist version, and free memory without a separate table.
 *
 * Run with: npx ts-node src/db/migrate-005.ts
 */
async function migrate() {
  console.log('Running migration 005 (device health)...');

  await db.query(`
    ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS last_health_payload JSONB;
  `);
  console.log('Added devices.last_health_payload.');

  console.log('Migration 005 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 005 failed:', err);
    process.exit(1);
  });
}
