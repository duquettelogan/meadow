import { db } from '../src/db/connection';

/**
 * Mark a parent's email as verified. Used by integration tests that
 * need to exercise endpoints behind the email-verification gate (POST
 * /api/v1/children, POST /api/v1/pairing/claim).
 *
 * Tests that specifically exercise the gate should NOT call this —
 * see tests/integration/email-verification-gate.test.ts.
 */
export async function verifyEmailFor(email: string): Promise<void> {
  await db.query(
    'UPDATE parents SET email_verified_at = NOW() WHERE email = $1',
    [email.toLowerCase()],
  );
}
