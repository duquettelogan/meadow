import { db } from './connection';

/**
 * Migration 013: Per-user invite codes (admin-managed).
 *
 * Replaces the SIGNUP_INVITE_CODE env-var matching path with a real
 * server-side table of single-use (or N-use) codes the admin can mint
 * via POST /api/v1/admin/invite-codes. When SIGNUP_ENABLED=false the
 * signup handler now consumes a row here instead of comparing against
 * the env var.
 *
 * Backfill: if SIGNUP_INVITE_CODE is set at migration time, seed a
 * matching row with no expiry + max_uses=1000 so existing alpha
 * signups using the env-var code keep working through the cutover.
 * Operators can rotate it later via the admin endpoint.
 *
 * Run with: npx ts-node src/db/migrate-013.ts
 */
async function migrate() {
  console.log('Running migration 013 (invite_codes)...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ,
      used_by_parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
      max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
      uses_count INTEGER NOT NULL DEFAULT 0 CHECK (uses_count >= 0)
    );
  `);
  console.log('Created invite_codes table.');

  // Seed alpha env-var code (if any) so the cutover doesn't break
  // existing closed-deploy signups. ON CONFLICT DO NOTHING in case
  // the migration runs twice.
  const seed = (process.env.SIGNUP_INVITE_CODE || '').trim();
  if (seed) {
    await db.query(
      `INSERT INTO invite_codes (code, max_uses, expires_at)
       VALUES ($1, 1000, NULL)
       ON CONFLICT (code) DO NOTHING`,
      [seed],
    );
    console.log(
      `Seeded SIGNUP_INVITE_CODE-alpha row (code length ${seed.length}, max_uses=1000, no expiry).`,
    );
  } else {
    console.log(
      'SIGNUP_INVITE_CODE not set at migration time — no seed row inserted.',
    );
  }

  console.log('Migration 013 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 013 failed:', err);
    process.exit(1);
  });
}
