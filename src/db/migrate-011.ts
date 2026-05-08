import { db } from './connection';

/**
 * Migration 011: Box offline alerts.
 *
 * Adds devices.offline_alert_sent_at TIMESTAMPTZ. The hourly worker
 * (src/workers/box-offline-watcher.ts) flips this from NULL to NOW()
 * the first time a box has been silent for >24h, sending the family a
 * "your Meadow box appears to be offline" email. The heartbeat handler
 * in src/api/server.ts flips it back to NULL when the box reconnects,
 * so the next 24h-silent stretch can trigger a fresh alert.
 *
 * Run with: npx ts-node src/db/migrate-011.ts
 */
async function migrate() {
  console.log('Running migration 011 (box offline alerts)...');

  await db.query(`
    ALTER TABLE devices
      ADD COLUMN IF NOT EXISTS offline_alert_sent_at TIMESTAMPTZ;
  `);
  console.log('Added devices.offline_alert_sent_at.');

  console.log('Migration 011 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 011 failed:', err);
    process.exit(1);
  });
}
