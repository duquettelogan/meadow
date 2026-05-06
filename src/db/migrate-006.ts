import { db } from './connection';

/**
 * Migration 006: Security hardening.
 *
 * Adds:
 *  1. audit_log table — append-only record of security-relevant actions.
 *  2. parents email-verification + password-reset token columns.
 *  3. parents TOTP scaffold columns (not enforced yet — Phase 4.5).
 *
 * Run with: npx ts-node src/db/migrate-006.ts
 */
async function migrate() {
  console.log('Running migration 006 (security)...');

  // ---------- audit_log ----------
  // Append-only. Never UPDATE or DELETE rows here in normal operation.
  // Schema is denormalized on purpose: we want each row to make sense
  // standalone even if a parent or family is deleted later.
  await db.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      family_id UUID,
      parent_id UUID,
      device_id UUID,
      action TEXT NOT NULL,
      target_kind TEXT,
      target_id TEXT,
      ip TEXT,
      user_agent TEXT,
      metadata JSONB
    );
  `);
  console.log('Created audit_log table.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_family_time
    ON audit_log (family_id, occurred_at DESC);
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_time
    ON audit_log (action, occurred_at DESC);
  `);

  // ---------- parents: email verification + password reset ----------
  await db.query(`
    ALTER TABLE parents
    ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS email_verification_token TEXT,
    ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS password_reset_token TEXT,
    ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;
  `);
  console.log('Added parents email/password recovery columns.');

  // Lookup the row by token efficiently when a parent clicks an email link.
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_parents_email_verification_token
    ON parents (email_verification_token)
    WHERE email_verification_token IS NOT NULL;
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_parents_password_reset_token
    ON parents (password_reset_token)
    WHERE password_reset_token IS NOT NULL;
  `);

  // ---------- parents: TOTP (Phase 4.5 scaffold; not enforced yet) ----------
  // totp_secret stored as base32, app-encrypted at rest using TOTP_ENCRYPTION_KEY.
  // Not wired into login flow yet — that lands when the dashboard ships
  // the enrollment UI.
  await db.query(`
    ALTER TABLE parents
    ADD COLUMN IF NOT EXISTS totp_secret_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS totp_enabled_at TIMESTAMPTZ;
  `);
  console.log('Added parents totp_* columns (scaffold).');

  console.log('Migration 006 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 006 failed:', err);
    process.exit(1);
  });
}
