import { db } from './connection';

/**
 * Migration 007: cascade behavior for child + device deletion.
 *
 * Lets DELETE /api/v1/children/:id and DELETE /api/v1/devices/:id
 * work cleanly without leaving orphaned rows behind.
 *
 * Changes:
 *  1. filter_policies.child_profile_id  → ON DELETE CASCADE
 *     (1:1 with child_profiles; the policy has no meaning without it)
 *
 *  2. devices.child_profile_id          → ON DELETE SET NULL
 *     (devices belong to the family, not the child — when a child is
 *     deleted the device stays in the family but becomes unassigned;
 *     parent can re-assign or DELETE it)
 *
 * Already cascading from earlier migrations (no change needed):
 *  - block_counters.child_profile_id    → CASCADE (set in migrate-002)
 *  - api_keys.device_id                 → CASCADE (set in migrate-003)
 *  - pairing_codes.device_id            → CASCADE (set in migrate-004)
 *  - pairing_codes.api_key_id           → CASCADE (set in migrate-004)
 *
 * audit_log has NO foreign keys by design (see src/audit/log.ts) —
 * rows are denormalized so they remain meaningful even after the
 * referenced parent / family / device is deleted. So audit_log
 * entries about the deleted child or device are PRESERVED, which is
 * exactly the behavior we want for accountability + COPPA-style
 * compliance trails.
 *
 * Run with: npx ts-node src/db/migrate-007.ts
 */
async function migrate() {
  console.log('Running migration 007 (deletion cascades)...');

  await db.query(`
    ALTER TABLE filter_policies
      DROP CONSTRAINT IF EXISTS filter_policies_child_profile_id_fkey;
  `);
  await db.query(`
    ALTER TABLE filter_policies
      ADD CONSTRAINT filter_policies_child_profile_id_fkey
      FOREIGN KEY (child_profile_id) REFERENCES child_profiles(id)
      ON DELETE CASCADE;
  `);
  console.log('filter_policies.child_profile_id now CASCADE-deletes.');

  await db.query(`
    ALTER TABLE devices
      DROP CONSTRAINT IF EXISTS devices_child_profile_id_fkey;
  `);
  await db.query(`
    ALTER TABLE devices
      ADD CONSTRAINT devices_child_profile_id_fkey
      FOREIGN KEY (child_profile_id) REFERENCES child_profiles(id)
      ON DELETE SET NULL;
  `);
  console.log('devices.child_profile_id now SET NULL on child delete.');

  console.log('Migration 007 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 007 failed:', err);
    process.exit(1);
  });
}
