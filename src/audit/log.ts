import type { Request } from 'express';
import { db } from '../db/connection';

/**
 * Audit logger.
 *
 * Append-only record of security-relevant actions. Goes into the
 * audit_log table created in migrate-006. NEVER updates, NEVER deletes.
 *
 * Failures are swallowed: audit writes must not block or break the
 * action they're recording. They're observability, not enforcement.
 *
 * Privacy note: audit rows record WHO did WHAT, never the contents of
 * the action. We do not log email subjects, password values, blocked
 * domains, or anything else that would compromise the privacy posture.
 * If you find yourself wanting to log content, push back — almost
 * always there's a way to capture it as metadata (e.g. "policy update
 * affected 3 fields") instead.
 */

export type AuditAction =
  // Auth
  | 'parent.signup'
  | 'parent.signup.rejected'
  | 'parent.login'
  | 'parent.login.failed'
  | 'parent.logout'
  | 'parent.password.changed'
  | 'parent.password.reset.requested'
  | 'parent.password.reset.completed'
  | 'parent.email.verification.requested'
  | 'parent.email.verified'
  // Resources
  | 'child.created'
  | 'child.policy.updated'
  | 'child.deleted'
  | 'family.policy.updated'
  | 'device.registered'
  | 'device.discovered'
  | 'device.updated'
  | 'device.key.issued'
  | 'device.key.revoked'
  | 'device.deleted'
  // Pairing
  | 'pairing.started'
  | 'pairing.claimed'
  | 'pairing.poll.hardware_mismatch'
  // Box
  | 'box.heartbeat'
  | 'box.network.reported'
  | 'box.network.conflict';

export interface AuditFields {
  family_id?: string | null;
  parent_id?: string | null;
  device_id?: string | null;
  target_kind?: string | null;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

function safeUserAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  if (typeof ua !== 'string') return null;
  return ua.slice(0, 500);
}

function safeIp(req: Request): string | null {
  // express.req.ip honors trust proxy, which we set in api/server.ts.
  return typeof req.ip === 'string' ? req.ip.slice(0, 64) : null;
}

/**
 * Record an audit row. Always returns — errors are logged and swallowed.
 *
 * Caller can `await` this for tests, but in production it's typically
 * fire-and-forget so it never blocks the response.
 */
export async function audit(
  req: Request,
  action: AuditAction,
  fields: AuditFields = {},
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO audit_log
         (family_id, parent_id, device_id, action,
          target_kind, target_id, ip, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        fields.family_id ?? req.parent?.family_id ?? null,
        fields.parent_id ?? req.parent?.parent_id ?? null,
        fields.device_id ?? req.device?.device_id ?? null,
        action,
        fields.target_kind ?? null,
        fields.target_id ?? null,
        safeIp(req),
        safeUserAgent(req),
        fields.metadata ? JSON.stringify(fields.metadata) : null,
      ],
    );
  } catch (err) {
    // Audit failures must never break the calling path — log and move on.
    console.error('[audit] write failed:', err);
  }
}
