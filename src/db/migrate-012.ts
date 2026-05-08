import { db } from './connection';

/**
 * Migration 012: Co-parent invitation flow.
 *
 * Adds the family_invitations table:
 *   - One row per outstanding invite. Tokenized magic-link is stored
 *     server-side; the link points at /accept-invite?token=… on the
 *     dashboard.
 *   - 7-day expiry by default — long enough to survive "I'll set it
 *     up after work" scenarios, short enough that a leaked invite
 *     mailbox doesn't grant indefinite access.
 *   - used_at NULL → still claimable. Stamped when the invite is
 *     consumed by POST /family/invite/accept.
 *
 * Cascade: invites are scoped to a family + invited_by parent; both FK
 * with ON DELETE CASCADE so deleting a family / parent doesn't leave
 * orphan invites pointing at vanished rows.
 *
 * Run with: npx ts-node src/db/migrate-012.ts
 */
async function migrate() {
  console.log('Running migration 012 (co-parent invitations)...');

  await db.query(`
    CREATE TABLE IF NOT EXISTS family_invitations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      family_id UUID NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      invited_by_parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  console.log('Created family_invitations table.');

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_family_invitations_token
    ON family_invitations (token)
    WHERE used_at IS NULL;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_family_invitations_family
    ON family_invitations (family_id);
  `);

  console.log('Migration 012 complete.');
  await db.end();
}

if (require.main === module) {
  migrate().catch((err) => {
    console.error('Migration 012 failed:', err);
    process.exit(1);
  });
}
