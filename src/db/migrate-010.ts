import { db } from './connection';

/**
 * Migration 010: Account management.
 *
 * Adds families.name TEXT for the family's display name (e.g. "The
 * Duquette Family"). Nullable — existing families don't have one until
 * the parent sets it via PATCH /api/v1/account.
 *
 * Run with: npx ts-node src/db/migrate-010.ts
 */
async function migrate() {
  console.log('Running migration 010 (families.name)...');

  await db.query(`
    ALTER TABLE families
      ADD COLUMN IF NOT EXISTS name TEXT;
  `);
  console.log('Added families.name.');

  console.log('Migration 010 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 010 failed:', err);
    process.exit(1);
  });
}
