import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/connection';
import {
  hashPassword,
  verifyPassword,
} from '../auth/passwords';
import {
  signParentToken,
  verifyParentToken,
  remainingTtlSeconds,
} from '../auth/jwt';
import { revokeJti, revokeAllForParent } from '../auth/revocation';
import { generateApiKey } from '../auth/keys';
import { requireParentAuth } from '../auth/middleware';
import { validateBody } from './middleware';
import {
  SignupBody,
  LoginBody,
  VerifyEmailBody,
  ForgotPasswordBody,
  ResetPasswordBody,
  ChangePasswordBody,
} from './validation';
import {
  loginLimiter,
  signupLimiter,
  passwordResetLimiter,
} from './rate-limits';
import { audit } from '../audit/log';
import { safeEqual } from '../auth/keys';
import {
  sendVerificationEmail,
  sendPasswordResetEmail,
} from '../email';

const router = express.Router();

const VERIFICATION_TTL_HOURS = 24;
const RESET_TTL_HOURS = 1;

function newToken(): string {
  // 32 bytes → 43 base64url chars. Plenty of entropy, URL-safe, no padding.
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Whether public signup is open. Read at request time so operators can
 * flip the env var via `fly secrets set` without a full restart cycle
 * picking up stale module-load values.
 *
 * Default: true (open signup). Disabled when SIGNUP_ENABLED is exactly
 * "false" or "0" — anything else (unset, "true", "1", "yes", etc.)
 * keeps signup open. Strict matching avoids "did the operator typo it
 * to 'False' and accidentally disable signup?" surprises.
 */
function isSignupEnabled(): boolean {
  const v = process.env.SIGNUP_ENABLED;
  if (v === undefined) return true;
  return v !== 'false' && v !== '0';
}

function expectedInviteCode(): string {
  return (process.env.SIGNUP_INVITE_CODE || '').trim();
}

/**
 * Returns true if the signup request is allowed under the current
 * SIGNUP_ENABLED / SIGNUP_INVITE_CODE policy.
 *
 * Truth table (SIGNUP_ENABLED, SIGNUP_INVITE_CODE):
 *   (true,  *)        → allowed (invite_code field ignored either way)
 *   (false, "")       → all signups rejected
 *   (false, "<code>") → only requests where body.invite_code === <code>
 */
function isSignupAllowed(suppliedInvite?: string): boolean {
  if (isSignupEnabled()) return true;
  const expected = expectedInviteCode();
  if (!expected) return false;
  if (typeof suppliedInvite !== 'string') return false;
  return safeEqual(suppliedInvite, expected);
}

/**
 * Signup: creates a family and the first parent, returns a JWT.
 * Also issues an email-verification token and best-effort sends the
 * verification email. Account is usable immediately — verification
 * gates future production-only features (e.g. shipping a hardware box).
 */
router.post(
  '/signup',
  signupLimiter,
  validateBody(SignupBody),
  async (req: Request, res: Response) => {
    const { email, password, invite_code } = req.body as {
      email: string;
      password: string;
      invite_code?: string;
    };

    // Signup gate: closed-deploy / invite-only mode. Run BEFORE the
    // expensive bcrypt hash + DB transaction so a closed deploy can
    // shed signup spam cheaply. The signupLimiter (5/IP/hour) is the
    // outer brute-force ceiling; safeEqual on the invite code is
    // belt-and-braces timing protection on top of that.
    if (!isSignupAllowed(invite_code)) {
      audit(req, 'parent.signup.rejected', {
        metadata: {
          reason: isSignupEnabled() ? 'invalid_invite' : 'signup_closed',
        },
      });
      res.status(403).json({ error: 'signup_closed' });
      return;
    }

    const verificationToken = newToken();
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const familyResult = await client.query(
        'INSERT INTO families (email) VALUES ($1) RETURNING id, email, created_at',
        [email]
      );
      const family = familyResult.rows[0];

      const passwordHash = await hashPassword(password);
      const parentResult = await client.query(
        `INSERT INTO parents
           (family_id, email, password_hash,
            email_verification_token, email_verification_expires_at)
         VALUES ($1, $2, $3, $4,
                 NOW() + INTERVAL '${VERIFICATION_TTL_HOURS} hours')
         RETURNING id, family_id, email, created_at`,
        [family.id, email, passwordHash, verificationToken]
      );
      const parent = parentResult.rows[0];

      await client.query('COMMIT');

      const token = signParentToken({
        parent_id: parent.id,
        family_id: parent.family_id,
      });

      // Best-effort email send. Provider failures are logged inside the
      // helper — they never break the signup response.
      sendVerificationEmail(email, verificationToken).catch(() => {});

      audit(req, 'parent.signup', {
        family_id: family.id,
        parent_id: parent.id,
      });

      res.status(201).json({
        token,
        parent: {
          id: parent.id,
          email: parent.email,
          family_id: parent.family_id,
        },
      });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        res.status(409).json({ error: 'email already registered' });
        return;
      }
      console.error('signup failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  }
);

/**
 * Login: same response shape for both unknown email and bad password.
 * Bcrypt always runs to keep timing roughly constant.
 */
router.post(
  '/login',
  loginLimiter,
  validateBody(LoginBody),
  async (req: Request, res: Response) => {
    const { email, password } = req.body as { email: string; password: string };

    try {
      const result = await db.query(
        `SELECT id, family_id, password_hash
         FROM parents WHERE email = $1`,
        [email]
      );
      const row = result.rows[0];

      // Run bcrypt even if user is missing — keeps timing roughly constant.
      const dummyHash =
        '$2b$12$abcdefghijklmnopqrstuvCqDkJZ4dbVOq2nJpAZ.1/cVfMzQUvbq';
      const ok = await verifyPassword(
        password,
        row?.password_hash ?? dummyHash
      );

      if (!row || !ok) {
        audit(req, 'parent.login.failed', {
          metadata: { email_attempted: email.slice(0, 64) },
        });
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }

      db.query('UPDATE parents SET last_login_at = NOW() WHERE id = $1', [
        row.id,
      ]).catch(() => {});

      const token = signParentToken({
        parent_id: row.id,
        family_id: row.family_id,
      });

      audit(req, 'parent.login', {
        family_id: row.family_id,
        parent_id: row.id,
      });

      res.json({
        token,
        parent: { id: row.id, email, family_id: row.family_id },
      });
    } catch (err) {
      console.error('login failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

/**
 * Logout — revokes just this token (jti). Other devices still work.
 */
router.post('/logout', requireParentAuth, async (req: Request, res: Response) => {
  try {
    const claims = req.parent!;
    if (claims.jti) {
      await revokeJti(claims.jti, remainingTtlSeconds(claims));
    }
    audit(req, 'parent.logout');
    res.json({ success: true });
  } catch (err) {
    console.error('logout failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

/**
 * /me — returns the current parent's identity.
 */
router.get('/me', requireParentAuth, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      `SELECT id, family_id, email, created_at, last_login_at,
              email_verified_at
       FROM parents WHERE id = $1`,
      [req.parent!.parent_id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'parent not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

/**
 * Resend verification email. Authenticated; deliberately NOT gated by
 * requireVerifiedParent (the whole point is for unverified parents to
 * trigger another email). Rate-limited via passwordResetLimiter so an
 * attacker with a stolen JWT can't email-bomb the user.
 *
 * If the parent is already verified, returns success with a flag so the
 * dashboard can surface "you're already verified" rather than confusing
 * the user with an error.
 */
router.post(
  '/resend-verification',
  passwordResetLimiter,
  requireParentAuth,
  async (req: Request, res: Response) => {
    try {
      const lookup = await db.query(
        'SELECT email, email_verified_at FROM parents WHERE id = $1',
        [req.parent!.parent_id],
      );
      if (lookup.rows.length === 0) {
        res.status(404).json({ error: 'parent not found' });
        return;
      }
      if (lookup.rows[0].email_verified_at) {
        res.json({ success: true, already_verified: true });
        return;
      }
      const token = newToken();
      await db.query(
        `UPDATE parents
         SET email_verification_token = $1,
             email_verification_expires_at = NOW() + INTERVAL '${VERIFICATION_TTL_HOURS} hours'
         WHERE id = $2`,
        [token, req.parent!.parent_id],
      );
      sendVerificationEmail(lookup.rows[0].email, token).catch(() => {});
      audit(req, 'parent.email.verification.requested');
      res.json({ success: true });
    } catch (err) {
      console.error('resend-verification failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

/**
 * Verify email — claims a verification token. Idempotent: claiming an
 * already-verified token is a no-op success (so a parent reloading the
 * verify page doesn't see a confusing error).
 */
router.post(
  '/verify-email',
  validateBody(VerifyEmailBody),
  async (req: Request, res: Response) => {
    const { token } = req.body as { token: string };
    try {
      const result = await db.query(
        `UPDATE parents
         SET email_verified_at = COALESCE(email_verified_at, NOW()),
             email_verification_token = NULL,
             email_verification_expires_at = NULL
         WHERE email_verification_token = $1
           AND email_verification_expires_at > NOW()
         RETURNING id, family_id`,
        [token],
      );
      if (result.rows.length === 0) {
        res.status(400).json({ error: 'invalid or expired token' });
        return;
      }
      audit(req, 'parent.email.verified', {
        family_id: result.rows[0].family_id,
        parent_id: result.rows[0].id,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('verify-email failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

/**
 * Forgot password — accepts an email, issues a reset token, sends an
 * email. Always returns success even for unknown emails so this endpoint
 * can't be used to enumerate accounts.
 */
router.post(
  '/forgot-password',
  passwordResetLimiter,
  validateBody(ForgotPasswordBody),
  async (req: Request, res: Response) => {
    const { email } = req.body as { email: string };
    try {
      const lookup = await db.query(
        'SELECT id, family_id FROM parents WHERE email = $1',
        [email],
      );
      if (lookup.rows.length > 0) {
        const token = newToken();
        await db.query(
          `UPDATE parents
           SET password_reset_token = $1,
               password_reset_expires_at = NOW() + INTERVAL '${RESET_TTL_HOURS} hours'
           WHERE id = $2`,
          [token, lookup.rows[0].id],
        );
        sendPasswordResetEmail(email, token).catch(() => {});
        audit(req, 'parent.password.reset.requested', {
          family_id: lookup.rows[0].family_id,
          parent_id: lookup.rows[0].id,
        });
      }
      // Same response either way — no enumeration.
      res.json({ success: true });
    } catch (err) {
      console.error('forgot-password failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

/**
 * Reset password — claims a reset token, sets a new password, revokes
 * every outstanding session for that parent (forces re-login everywhere).
 */
router.post(
  '/reset-password',
  passwordResetLimiter,
  validateBody(ResetPasswordBody),
  async (req: Request, res: Response) => {
    const { token, password } = req.body as { token: string; password: string };
    try {
      const lookup = await db.query(
        `SELECT id, family_id FROM parents
         WHERE password_reset_token = $1
           AND password_reset_expires_at > NOW()`,
        [token],
      );
      if (lookup.rows.length === 0) {
        res.status(400).json({ error: 'invalid or expired token' });
        return;
      }
      const parentId = lookup.rows[0].id;
      const newHash = await hashPassword(password);
      await db.query(
        `UPDATE parents
         SET password_hash = $1,
             password_reset_token = NULL,
             password_reset_expires_at = NULL
         WHERE id = $2`,
        [newHash, parentId],
      );
      await revokeAllForParent(parentId);
      audit(req, 'parent.password.reset.completed', {
        family_id: lookup.rows[0].family_id,
        parent_id: parentId,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('reset-password failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

/**
 * Change password — authenticated. Requires the current password to
 * prove the session-holder is the actual account owner. Revokes all
 * other sessions on success (this one keeps working until next request).
 */
router.post(
  '/change-password',
  requireParentAuth,
  validateBody(ChangePasswordBody),
  async (req: Request, res: Response) => {
    const { current_password, new_password } = req.body as {
      current_password: string;
      new_password: string;
    };
    try {
      const lookup = await db.query(
        'SELECT password_hash FROM parents WHERE id = $1',
        [req.parent!.parent_id],
      );
      if (lookup.rows.length === 0) {
        res.status(404).json({ error: 'parent not found' });
        return;
      }
      const ok = await verifyPassword(current_password, lookup.rows[0].password_hash);
      if (!ok) {
        res.status(401).json({ error: 'current password incorrect' });
        return;
      }
      const newHash = await hashPassword(new_password);
      await db.query(
        'UPDATE parents SET password_hash = $1 WHERE id = $2',
        [newHash, req.parent!.parent_id],
      );
      await revokeAllForParent(req.parent!.parent_id);
      audit(req, 'parent.password.changed');
      res.json({ success: true });
    } catch (err) {
      console.error('change-password failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

/**
 * Generate a new API key for a device. Returns the plaintext key once.
 */
router.post(
  '/devices/:deviceId/keys',
  requireParentAuth,
  async (req: Request, res: Response) => {
    const deviceId = req.params.deviceId as string;

    try {
      const owns = await db.query(
        `SELECT 1 FROM devices d WHERE d.id = $1 AND d.family_id = $2`,
        [deviceId, req.parent!.family_id]
      );
      if (owns.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      const key = generateApiKey();
      await db.query(
        `INSERT INTO api_keys (device_id, key_prefix, key_hash)
         VALUES ($1, $2, $3)`,
        [deviceId, key.prefix, key.hash]
      );

      audit(req, 'device.key.issued', {
        device_id: deviceId,
        target_kind: 'device',
        target_id: deviceId,
      });

      res.status(201).json({
        key: key.plaintext,
        prefix: key.prefix,
        warning: 'Store this key now. It will not be shown again.',
      });
    } catch (err) {
      console.error('key generation failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

/**
 * Revoke a device key.
 */
router.delete(
  '/devices/:deviceId/keys/:keyId',
  requireParentAuth,
  async (req: Request, res: Response) => {
    const deviceId = req.params.deviceId as string;
    const keyId = req.params.keyId as string;

    try {
      const owns = await db.query(
        `SELECT 1 FROM api_keys k
         JOIN devices d ON d.id = k.device_id
         WHERE k.id = $1 AND k.device_id = $2 AND d.family_id = $3`,
        [keyId, deviceId, req.parent!.family_id]
      );
      if (owns.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      await db.query(
        'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1',
        [keyId]
      );
      audit(req, 'device.key.revoked', {
        device_id: deviceId,
        target_kind: 'api_key',
        target_id: keyId,
      });
      res.json({ success: true });
    } catch (err) {
      console.error('key revocation failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

export { router as authRouter };
