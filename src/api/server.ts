import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import crypto from 'crypto';
import { db } from '../db/connection';
import { getDailyBlockCount, getTotalsByCategory } from '../db/counters';
import { authRouter } from './auth-routes';
import { pairingRouter } from './pairing-routes';
import {
  requireParentAuth,
  requireParentForChild,
  requireDeviceAuth,
  requireVerifiedParent,
} from '../auth/middleware';
import {
  validateBody,
  errorHandler,
  requestLogger,
} from './middleware';
import {
  CreateChildBody,
  UpdatePolicyBody,
  RegisterDeviceBody,
  ResolveBody,
  AnalyzeBody,
  HeartbeatBody,
  DiscoveredDeviceBody,
  UpdateDeviceBody,
  BoxNetworkStatusBody,
  UpdateAccountBody,
  DeleteAccountBody,
  FamilyInviteBody,
  FamilyInviteAcceptBody,
  AdminCreateInviteCodeBody,
} from './validation';
import { resolveLimiter, defaultLimiter } from './rate-limits';
import { audit } from '../audit/log';
import { verifyPassword, hashPassword } from '../auth/passwords';
import { revokeAllForParent } from '../auth/revocation';
import { signParentToken } from '../auth/jwt';
import { sendVerificationEmail, sendFamilyInviteEmail } from '../email';

const app = express();

// Trust the first proxy hop (cloudflared / future load balancer) so
// express-rate-limit can read the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);

// ---------- Security middleware ----------
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// CORS: allow configured origins from env, plus any *.base44.com / *.base44.app
// (so the dashboard works in dev). Tighten for production by removing the
// regex fallback.
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3001'
).split(',').map(s => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      try {
        const host = new URL(origin).hostname;
        if (host.endsWith('.base44.com') || host.endsWith('.base44.app')) {
          return cb(null, true);
        }
      } catch {}
      cb(null, false);
    },
    credentials: true,
  })
);

// Body limits — JSON capped at 100kb. DNS messages capped at 8kb.
app.use(express.json({ limit: '100kb' }));
app.use('/dns-query', express.raw({
  type: 'application/dns-message',
  limit: '8kb',
}));

app.use(requestLogger);

// ---------- Public ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meadow-api' });
});

// Auth router has its own rate limits on signup/login.
app.use('/api/v1/auth', authRouter);

// Pairing routes have their own rate limits inside the router.
app.use('/api/v1/pairing', pairingRouter);

// Default rate limit for everything else under /api/v1.
app.use('/api/v1', defaultLimiter);

// ---------- Admin ----------
//
// Admin gate: env IS_ADMIN_EMAIL is a comma-separated allowlist of
// parent email addresses. The middleware reads it at request time so
// `fly secrets set IS_ADMIN_EMAIL=...` takes effect without a restart.
//
// Lookup pattern matches requireVerifiedParent — small DB hit per
// call, but admin routes aren't hot. If usage grows we can cache
// admin status on the JWT claims set.
async function requireAdminParent(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): Promise<void> {
  if (!req.parent) {
    res.status(401).json({ error: 'auth required' });
    return;
  }
  const allowlist = (process.env.IS_ADMIN_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) {
    res.status(403).json({ error: 'admin disabled' });
    return;
  }
  try {
    const lookup = await db.query(
      'SELECT email FROM parents WHERE id = $1',
      [req.parent.parent_id],
    );
    const callerEmail = lookup.rows[0]?.email?.toLowerCase();
    if (!callerEmail || !allowlist.includes(callerEmail)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  } catch (err) {
    console.error('admin gate failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
}

// POST /api/v1/admin/invite-codes — mint a new invite code.
//   body: { max_uses?, expires_in_days? }
// Code is 16 random hex chars (~10^19 combinations) — enough entropy
// for a single-use signup gate in a closed deploy.
app.post(
  '/api/v1/admin/invite-codes',
  requireParentAuth,
  requireAdminParent,
  validateBody(AdminCreateInviteCodeBody),
  async (req, res) => {
    const { max_uses, expires_in_days } = req.body as {
      max_uses?: number;
      expires_in_days?: number;
    };
    try {
      const code = crypto.randomBytes(8).toString('hex');
      const inserted = await db.query(
        `INSERT INTO invite_codes
           (code, created_by_parent_id, max_uses, expires_at)
         VALUES ($1, $2, $3,
                 ${expires_in_days ? `NOW() + ($4 || ' days')::interval` : `NULL`})
         RETURNING code, created_at, expires_at, max_uses`,
        expires_in_days
          ? [code, req.parent!.parent_id, max_uses ?? 1, String(expires_in_days)]
          : [code, req.parent!.parent_id, max_uses ?? 1],
      );
      audit(req, 'admin.invite_code.created', {
        target_kind: 'invite_code',
        target_id: code,
        metadata: {
          max_uses: inserted.rows[0].max_uses,
          expires_in_days: expires_in_days ?? null,
        },
      });
      res.status(201).json(inserted.rows[0]);
    } catch (err) {
      console.error('admin invite-code create failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// GET /api/v1/admin/invite-codes — list every code with derived status.
//
//   status: 'expired' | 'used' | 'active'
//
// "used" means uses_count >= max_uses. "expired" wins over both if the
// expires_at fence has been crossed (an expired code is no longer
// useful even if uses are left). "active" otherwise.
app.get(
  '/api/v1/admin/invite-codes',
  requireParentAuth,
  requireAdminParent,
  async (_req, res) => {
    try {
      const result = await db.query(
        `SELECT code, created_by_parent_id, created_at,
                expires_at, used_at, used_by_parent_id,
                max_uses, uses_count,
                CASE
                  WHEN expires_at IS NOT NULL AND expires_at < NOW()
                    THEN 'expired'
                  WHEN uses_count >= max_uses
                    THEN 'used'
                  ELSE 'active'
                END AS status
         FROM invite_codes
         ORDER BY created_at DESC`,
      );
      res.json({ codes: result.rows });
    } catch (err) {
      console.error('admin invite-code list failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// ---------- Family ----------
app.get('/api/v1/families/me', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, name, created_at FROM families WHERE id = $1',
      [req.parent!.family_id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'family not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------- Account management ----------
//
// PATCH /api/v1/account — update the calling parent's account fields.
//
//   body: { family_name?, email? }   (at least one required)
//
// family_name persists on families.name (denormalized for the
// dashboard's "The Duquette Family" header). email updates the
// authenticated parent's email AND clears email_verified_at, then
// fires a verification email so the new address has to be re-proven
// before any verified-only action (pairing claim, filter-policy PUT)
// works again. families.email is also resynced when this parent is
// the founding parent (i.e. their old email matches families.email)
// so the global UNIQUE constraint isn't left holding a stale value.
app.patch(
  '/api/v1/account',
  requireParentAuth,
  validateBody(UpdateAccountBody),
  async (req, res) => {
    const { family_name, email } = req.body as {
      family_name?: string;
      email?: string;
    };
    const parentId = req.parent!.parent_id;
    const familyId = req.parent!.family_id;

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      if (family_name !== undefined) {
        await client.query(
          'UPDATE families SET name = $1 WHERE id = $2',
          [family_name, familyId],
        );
      }

      let verificationToken: string | null = null;
      let newEmail: string | null = null;
      if (email !== undefined) {
        // Existing parent row — we need the old email to decide
        // whether to resync families.email below.
        const cur = await client.query(
          'SELECT email FROM parents WHERE id = $1',
          [parentId],
        );
        if (cur.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ error: 'parent not found' });
          return;
        }
        const oldEmail = cur.rows[0].email as string;

        // Email collisions across parents are caught by the parents
        // UNIQUE constraint — return 409 instead of letting Postgres
        // surface the raw error.
        verificationToken = crypto.randomBytes(32).toString('base64url');
        try {
          await client.query(
            `UPDATE parents SET
               email = $1,
               email_verified_at = NULL,
               email_verification_token = $2,
               email_verification_expires_at = NOW() + INTERVAL '24 hours'
             WHERE id = $3`,
            [email, verificationToken, parentId],
          );
        } catch (err: any) {
          if (err.code === '23505') {
            await client.query('ROLLBACK');
            res.status(409).json({ error: 'email already registered' });
            return;
          }
          throw err;
        }

        // Keep families.email in sync when the founding parent rotates
        // their email; co-parents (when invite flow lands) won't trigger
        // this branch because their email never matched families.email.
        const fam = await client.query(
          'SELECT email FROM families WHERE id = $1',
          [familyId],
        );
        if (
          fam.rows.length === 1 &&
          fam.rows[0].email.toLowerCase() === oldEmail.toLowerCase()
        ) {
          try {
            await client.query(
              'UPDATE families SET email = $1 WHERE id = $2',
              [email, familyId],
            );
          } catch (err: any) {
            if (err.code === '23505') {
              await client.query('ROLLBACK');
              res.status(409).json({ error: 'email already registered' });
              return;
            }
            throw err;
          }
        }
        newEmail = email;
      }

      await client.query('COMMIT');

      // Outside the transaction: best-effort verification email.
      if (newEmail && verificationToken) {
        sendVerificationEmail(newEmail, verificationToken).catch(() => {});
      }

      audit(req, 'parent.account.updated', {
        target_kind: 'parent',
        target_id: parentId,
        metadata: {
          fields_changed: Object.keys(req.body ?? {}),
        },
      });

      // Re-read the canonical state so the client doesn't have to
      // reconstruct it from the patch body.
      const out = await db.query(
        `SELECT p.id AS parent_id, p.email, p.email_verified_at,
                f.id AS family_id, f.email AS family_email, f.name AS family_name
         FROM parents p
         JOIN families f ON f.id = p.family_id
         WHERE p.id = $1`,
        [parentId],
      );
      res.json(out.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('account patch failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// DELETE /api/v1/account — hard-delete the entire family.
//
//   body: { password_confirmation }
//
// Requires the calling parent's password. Tears down the family and
// every dependent row (children, devices, api_keys, pairing_codes,
// filter_policies, block_counters, parents). audit_log rows are
// preserved (denormalized, no FK — see migrate-006 for the contract).
//
// Same manual-cleanup posture as DELETE /children + /devices: explicit
// deletes inside a transaction so the prod schema's missing CASCADEs
// can't break us.
app.delete(
  '/api/v1/account',
  requireParentAuth,
  validateBody(DeleteAccountBody),
  async (req, res) => {
    const { password_confirmation } = req.body as {
      password_confirmation: string;
    };
    const parentId = req.parent!.parent_id;
    const familyId = req.parent!.family_id;

    const client = await db.connect();
    try {
      const lookup = await client.query(
        'SELECT password_hash FROM parents WHERE id = $1',
        [parentId],
      );
      if (lookup.rows.length === 0) {
        res.status(404).json({ error: 'parent not found' });
        return;
      }
      const ok = await verifyPassword(
        password_confirmation,
        lookup.rows[0].password_hash,
      );
      if (!ok) {
        res.status(401).json({ error: 'password incorrect' });
        return;
      }

      await client.query('BEGIN');

      // Order: leaf-first, working up to families. block_counters and
      // api_keys cascade, but everything else has a NO ACTION FK so we
      // do them by hand.
      await client.query(
        `DELETE FROM pairing_codes
         WHERE family_id = $1
            OR device_id IN (SELECT id FROM devices WHERE family_id = $1)
            OR api_key_id IN (
              SELECT k.id FROM api_keys k
              JOIN devices d ON d.id = k.device_id
              WHERE d.family_id = $1
            )`,
        [familyId],
      );
      await client.query(
        `DELETE FROM api_keys WHERE device_id IN (
           SELECT id FROM devices WHERE family_id = $1
         )`,
        [familyId],
      );
      await client.query(
        'DELETE FROM devices WHERE family_id = $1',
        [familyId],
      );
      await client.query(
        `DELETE FROM block_counters WHERE child_profile_id IN (
           SELECT id FROM child_profiles WHERE family_id = $1
         )`,
        [familyId],
      );
      await client.query(
        `DELETE FROM filter_policies WHERE child_profile_id IN (
           SELECT id FROM child_profiles WHERE family_id = $1
         )`,
        [familyId],
      );
      await client.query(
        'DELETE FROM child_profiles WHERE family_id = $1',
        [familyId],
      );
      // parents have ON DELETE CASCADE on family_id, so deleting the
      // family wipes them. Audit row is appended after COMMIT.
      await client.query('DELETE FROM families WHERE id = $1', [familyId]);

      await client.query('COMMIT');

      audit(req, 'family.deleted', {
        target_kind: 'family',
        target_id: familyId,
        metadata: { parent_id: parentId },
      });

      // Revoke every JWT for this parent immediately so the dashboard
      // stops accepting their tokens (other co-parents would also have
      // been wiped above; their tokens become invalid via the parents
      // FK cascade taking out their parent row).
      revokeAllForParent(parentId).catch(() => {});

      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('account delete failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// ---------- Co-parent invitations ----------
//
// Family-level multi-parent membership. The founding parent (or any
// already-verified co-parent) emails an invite to a partner; the
// partner clicks the magic link, picks a password, and joins the same
// family with their own parent_id. From there both parents can manage
// children, devices, and the household filter policy.

// POST /api/v1/family/invite — create + email an invitation.
//   body: { email }
// Verified-parent gate: pairing-claim-grade trust to add a co-parent.
app.post(
  '/api/v1/family/invite',
  requireParentAuth,
  requireVerifiedParent,
  validateBody(FamilyInviteBody),
  async (req, res) => {
    const { email } = req.body as { email: string };
    const familyId = req.parent!.family_id;
    const inviterId = req.parent!.parent_id;

    try {
      // Refuse if there's already a parent on this email globally —
      // they'd hit a UNIQUE collision when accepting. Better to surface
      // the conflict before sending the email.
      const existing = await db.query(
        'SELECT 1 FROM parents WHERE email = $1',
        [email],
      );
      if (existing.rows.length > 0) {
        res.status(409).json({ error: 'email already registered' });
        return;
      }

      const token = crypto.randomBytes(32).toString('base64url');
      const ins = await db.query(
        `INSERT INTO family_invitations
           (family_id, invited_by_parent_id, email, token)
         VALUES ($1, $2, $3, $4)
         RETURNING id, expires_at`,
        [familyId, inviterId, email, token],
      );

      // Look up dressing for the email — inviter's email + family name
      // (if they've set one via PATCH /account).
      const ctx = await db.query(
        `SELECT p.email AS inviter_email, f.email AS family_email
         FROM parents p
         JOIN families f ON f.id = p.family_id
         WHERE p.id = $1`,
        [inviterId],
      );
      const inviterEmail = ctx.rows[0]?.inviter_email;

      sendFamilyInviteEmail(email, token, {
        invitedByEmail: inviterEmail,
        familyName: null,
      }).catch(() => {});

      audit(req, 'parent.invite.created', {
        target_kind: 'family_invitation',
        target_id: ins.rows[0].id,
        metadata: { email },
      });

      res.status(201).json({
        id: ins.rows[0].id,
        email,
        expires_at: ins.rows[0].expires_at,
      });
    } catch (err) {
      console.error('family invite failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// POST /api/v1/family/invite/accept — anonymous; consumes the magic
// link token, creates the new parent under the existing family, and
// returns a JWT.
//
//   body: { token, password }
//
// Email is taken from the invitation row (not body) so a stolen
// token can't be redirected to a different mailbox.
app.post(
  '/api/v1/family/invite/accept',
  validateBody(FamilyInviteAcceptBody),
  async (req, res) => {
    const { token, password } = req.body as {
      token: string;
      password: string;
    };

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const inv = await client.query(
        `SELECT id, family_id, email, expires_at, used_at
         FROM family_invitations
         WHERE token = $1
         FOR UPDATE`,
        [token],
      );
      if (inv.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'invalid token' });
        return;
      }
      const row = inv.rows[0];
      if (row.used_at) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'invitation already used' });
        return;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query('ROLLBACK');
        res.status(410).json({ error: 'invitation expired' });
        return;
      }

      const passwordHash = await hashPassword(password);
      let parent;
      try {
        const inserted = await client.query(
          `INSERT INTO parents
             (family_id, email, password_hash, email_verified_at)
           VALUES ($1, $2, $3, NOW())
           RETURNING id, family_id, email, created_at`,
          [row.family_id, row.email, passwordHash],
        );
        parent = inserted.rows[0];
      } catch (err: any) {
        if (err.code === '23505') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: 'email already registered' });
          return;
        }
        throw err;
      }

      await client.query(
        'UPDATE family_invitations SET used_at = NOW() WHERE id = $1',
        [row.id],
      );

      await client.query('COMMIT');

      audit(req, 'parent.invite.accepted', {
        family_id: parent.family_id,
        parent_id: parent.id,
        target_kind: 'family_invitation',
        target_id: row.id,
      });

      const jwt = signParentToken({
        parent_id: parent.id,
        family_id: parent.family_id,
      });
      res.status(201).json({
        token: jwt,
        parent: {
          id: parent.id,
          email: parent.email,
          family_id: parent.family_id,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('invite accept failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// GET /api/v1/family/parents — list every parent on the caller's family.
// No password hashes; just identity + verification status + when they
// joined.
app.get('/api/v1/family/parents', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, email, email_verified_at, created_at, last_login_at
       FROM parents
       WHERE family_id = $1
       ORDER BY created_at ASC`,
      [req.parent!.family_id],
    );
    res.json({ parents: result.rows });
  } catch (err) {
    console.error('list parents failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// DELETE /api/v1/family/parents/:id — remove a co-parent from the family.
//
// Refuses self-removal (use DELETE /account if you want to leave) and
// last-parent removal (would orphan the family). Co-parent removal
// requires verified-parent posture.
app.delete(
  '/api/v1/family/parents/:id',
  requireParentAuth,
  requireVerifiedParent,
  async (req, res) => {
    const targetId = req.params.id as string;
    const familyId = req.parent!.family_id;
    const callerId = req.parent!.parent_id;

    if (targetId === callerId) {
      res
        .status(400)
        .json({ error: 'cannot remove yourself; use DELETE /api/v1/account' });
      return;
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const target = await client.query(
        'SELECT 1 FROM parents WHERE id = $1 AND family_id = $2',
        [targetId, familyId],
      );
      if (target.rows.length === 0) {
        await client.query('ROLLBACK');
        // Conflate "doesn't exist" / "not in your family" — same
        // posture as DELETE /children to avoid existence-probing.
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      const count = await client.query(
        'SELECT COUNT(*)::int AS c FROM parents WHERE family_id = $1',
        [familyId],
      );
      if (count.rows[0].c <= 1) {
        await client.query('ROLLBACK');
        res
          .status(400)
          .json({ error: 'cannot remove the last parent in a family' });
        return;
      }

      await client.query('DELETE FROM parents WHERE id = $1', [targetId]);

      await client.query('COMMIT');

      audit(req, 'parent.removed', {
        target_kind: 'parent',
        target_id: targetId,
      });

      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('remove parent failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// ---------- Children ----------
// Adding a child profile is just metadata — name + tier — and doesn't
// itself touch any sensitive surface. The email-verification gate
// stays on POST /api/v1/pairing/claim (the truly sensitive action:
// claiming a hardware box and binding it to the family). A parent
// who hasn't verified their email yet can still set up child names
// in the dashboard.
app.post(
  '/api/v1/children',
  requireParentAuth,
  validateBody(CreateChildBody),
  async (req, res) => {
    const { name, tier } = req.body as { name: string; tier?: string };
    try {
      const child = await db.query(
        `INSERT INTO child_profiles (family_id, name, tier)
         VALUES ($1, $2, COALESCE($3, 'standard'))
         RETURNING id, family_id, name, tier, created_at`,
        [req.parent!.family_id, name, tier ?? null]
      );
      await db.query(
        'INSERT INTO filter_policies (child_profile_id) VALUES ($1)',
        [child.rows[0].id]
      );
      audit(req, 'child.created', {
        target_kind: 'child_profile',
        target_id: child.rows[0].id,
        metadata: { name, tier: child.rows[0].tier },
      });
      res.status(201).json(child.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// List all children in the parent's family. Returns each child with
// today's block count rolled in to avoid N+1 calls from the dashboard.
//
// The synthetic Household child (is_household=true) is excluded — it
// holds the family-wide filter policy and is managed via
// GET/PUT /api/v1/filter-policy, not by the per-child UI.
app.get('/api/v1/children', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.family_id, c.name, c.tier, c.created_at,
              COALESCE(SUM(b.count), 0)::int AS blocks_today
       FROM child_profiles c
       LEFT JOIN block_counters b
         ON b.child_profile_id = c.id
        AND b.day = CURRENT_DATE
       WHERE c.family_id = $1 AND c.is_household = false
       GROUP BY c.id
       ORDER BY c.created_at ASC`,
      [req.parent!.family_id]
    );
    res.json({ children: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------- Family-scoped filter policy ----------
// In v1, the resolver always uses the family's Household child's
// filter_policy. These endpoints are the dashboard-facing way to
// read/update it without exposing the Household-as-child mechanic.
app.get('/api/v1/filter-policy', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.id,
              p.blocked_categories, p.allowed_domains, p.blocked_domains,
              p.safe_search_enforce, p.youtube_restrict
       FROM filter_policies p
       JOIN child_profiles c ON c.id = p.child_profile_id
       WHERE c.family_id = $1 AND c.is_household = true`,
      [req.parent!.family_id]
    );
    if (result.rows.length === 0) {
      // Should not happen post-migration-008, but be defensive — every
      // family is supposed to have exactly one Household.
      res.status(404).json({ error: 'household policy not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.put(
  '/api/v1/filter-policy',
  requireParentAuth,
  requireVerifiedParent,
  validateBody(UpdatePolicyBody),
  async (req, res) => {
    const {
      blocked_categories,
      allowed_domains,
      blocked_domains,
      safe_search_enforce,
      youtube_restrict,
    } = req.body as {
      blocked_categories?: string[];
      allowed_domains?: string[];
      blocked_domains?: string[];
      safe_search_enforce?: boolean;
      youtube_restrict?: boolean;
    };
    try {
      const result = await db.query(
        `UPDATE filter_policies p SET
           blocked_categories = COALESCE($1, p.blocked_categories),
           allowed_domains = COALESCE($2, p.allowed_domains),
           blocked_domains = COALESCE($3, p.blocked_domains),
           safe_search_enforce = COALESCE($4, p.safe_search_enforce),
           youtube_restrict = COALESCE($5, p.youtube_restrict)
         FROM child_profiles c
         WHERE p.child_profile_id = c.id
           AND c.family_id = $6
           AND c.is_household = true
         RETURNING p.id`,
        [
          blocked_categories ? JSON.stringify(blocked_categories) : null,
          allowed_domains ? JSON.stringify(allowed_domains) : null,
          blocked_domains ? JSON.stringify(blocked_domains) : null,
          safe_search_enforce ?? null,
          youtube_restrict ?? null,
          req.parent!.family_id,
        ]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'household policy not found' });
        return;
      }
      audit(req, 'family.policy.updated', {
        target_kind: 'filter_policy',
        target_id: result.rows[0].id,
        metadata: { fields_changed: Object.keys(req.body ?? {}) },
      });
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

app.get(
  '/api/v1/children/:childId',
  requireParentForChild('childId'),
  async (req, res) => {
    const childId = req.params.childId as string;
    try {
      const result = await db.query(
        `SELECT c.id, c.family_id, c.name, c.tier,
                p.blocked_categories, p.allowed_domains, p.blocked_domains,
                p.safe_search_enforce, p.youtube_restrict
         FROM child_profiles c
         JOIN filter_policies p ON p.child_profile_id = c.id
         WHERE c.id = $1`,
        [childId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: 'child not found' });
        return;
      }
      res.json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

app.patch(
  '/api/v1/children/:childId/policy',
  requireParentForChild('childId'),
  validateBody(UpdatePolicyBody),
  async (req, res) => {
    const childId = req.params.childId as string;
    const {
      blocked_categories,
      allowed_domains,
      blocked_domains,
      safe_search_enforce,
      youtube_restrict,
    } = req.body as {
      blocked_categories?: string[];
      allowed_domains?: string[];
      blocked_domains?: string[];
      safe_search_enforce?: boolean;
      youtube_restrict?: boolean;
    };
    try {
      await db.query(
        `UPDATE filter_policies SET
           blocked_categories = COALESCE($1, blocked_categories),
           allowed_domains = COALESCE($2, allowed_domains),
           blocked_domains = COALESCE($3, blocked_domains),
           safe_search_enforce = COALESCE($4, safe_search_enforce),
           youtube_restrict = COALESCE($5, youtube_restrict)
         WHERE child_profile_id = $6`,
        [
          blocked_categories ? JSON.stringify(blocked_categories) : null,
          allowed_domains ? JSON.stringify(allowed_domains) : null,
          blocked_domains ? JSON.stringify(blocked_domains) : null,
          safe_search_enforce ?? null,
          youtube_restrict ?? null,
          childId,
        ]
      );
      audit(req, 'child.policy.updated', {
        target_kind: 'child_profile',
        target_id: childId,
        metadata: {
          fields_changed: Object.keys(req.body ?? {}),
        },
      });
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// Delete a child profile. Verified parent must own the child's family.
//
// Cleanup is done MANUALLY in a transaction rather than relying on FK
// CASCADE. Migration 007 was supposed to add ON DELETE CASCADE to
// filter_policies and SET NULL to devices.child_profile_id, but it
// landed inconsistently in production (Postgres auto-generated FK names
// can vary, and the DROP CONSTRAINT IF EXISTS ... ADD CONSTRAINT
// approach can leave a duplicate restrictive constraint that blocks
// the cascade). Doing the cleanup explicitly here is bulletproof:
// works regardless of whether the schema-level cascades are wired up.
//
// Cleanup contract:
//   - filter_policies rows for this child:  DELETED
//   - block_counters rows for this child:   DELETED
//   - devices.child_profile_id == childId:  SET NULL (devices survive
//                                           in the family as unassigned)
//   - audit_log rows about this child:      PRESERVED (no FK by design)
//   - new audit row child.deleted:          appended after COMMIT
app.delete(
  '/api/v1/children/:childId',
  requireParentAuth,
  requireVerifiedParent,
  async (req, res) => {
    const childId = req.params.childId as string;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Ownership check inside the transaction so a concurrent delete
      // can't slip in between SELECT and DELETE. Conflates "doesn't
      // exist" and "not in your family" — same response prevents
      // existence-probing across families.
      const owns = await client.query(
        `SELECT 1 FROM child_profiles
         WHERE id = $1 AND family_id = $2`,
        [childId, req.parent!.family_id],
      );
      if (owns.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      // Order matters: clear/cleanup dependents before the parent row.
      // SET NULL on devices first so they survive as unassigned.
      await client.query(
        'UPDATE devices SET child_profile_id = NULL WHERE child_profile_id = $1',
        [childId],
      );
      await client.query(
        'DELETE FROM block_counters WHERE child_profile_id = $1',
        [childId],
      );
      await client.query(
        'DELETE FROM filter_policies WHERE child_profile_id = $1',
        [childId],
      );
      await client.query(
        'DELETE FROM child_profiles WHERE id = $1',
        [childId],
      );

      await client.query('COMMIT');

      audit(req, 'child.deleted', {
        target_kind: 'child_profile',
        target_id: childId,
      });

      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('child delete failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// ---------- Devices ----------
app.post(
  '/api/v1/devices/register',
  requireParentAuth,
  validateBody(RegisterDeviceBody),
  async (req, res) => {
    const { child_profile_id, platform, device_token } = req.body as {
      child_profile_id?: string;
      platform: string;
      device_token: string;
    };

    try {
      if (child_profile_id) {
        const owns = await db.query(
          'SELECT 1 FROM child_profiles WHERE id = $1 AND family_id = $2',
          [child_profile_id, req.parent!.family_id]
        );
        if (owns.rows.length === 0) {
          res.status(403).json({ error: 'child not in your family' });
          return;
        }
      }

      const result = await db.query(
        `INSERT INTO devices (family_id, child_profile_id, platform, device_token, last_seen)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (device_token)
         DO UPDATE SET last_seen = NOW(), child_profile_id = $2
         RETURNING id, family_id, child_profile_id, platform, last_seen`,
        [req.parent!.family_id, child_profile_id ?? null, platform, device_token]
      );
      audit(req, 'device.registered', {
        target_kind: 'device',
        target_id: result.rows[0].id,
        metadata: { platform, child_profile_id: child_profile_id ?? null },
      });
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// List all devices in the parent's family. Joined with child name so the
// dashboard can render "Living room TV — assigned to Emma" without a
// second call. Never returns device_token (that's the device's secret).
//
// In the v1 household model, child_profile_id on a device is COSMETIC —
// the resolver always uses the family's Household policy. The dashboard
// surfaces the assignment so parents can label "this is Emma's iPad"
// without changing how DNS gets filtered.
app.get('/api/v1/devices', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT d.id, d.platform, d.last_seen,
              d.hostname, d.manufacturer, d.mac,
              d.child_profile_id, c.name AS child_name
       FROM devices d
       LEFT JOIN child_profiles c ON c.id = d.child_profile_id
       WHERE d.family_id = $1
       ORDER BY d.last_seen DESC NULLS LAST`,
      [req.parent!.family_id]
    );
    res.json({ devices: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Box-side endpoint: "I just saw this MAC on the LAN, here's what I
// know about it." Idempotent — the unique constraint on (family_id, mac)
// turns repeats into UPDATE last_seen + best-effort hostname/manufacturer
// fill-ins. Auth: device API key (the box's), so the family is taken
// from req.device.family_id rather than the body.
//
// On insert, device_token is generated server-side as `disc_<32 hex>`
// — discovered devices don't authenticate (nobody has the corresponding
// api_key), the column just satisfies the NOT NULL UNIQUE constraint.
app.post(
  '/api/v1/devices/discovered',
  requireDeviceAuth,
  validateBody(DiscoveredDeviceBody),
  async (req, res) => {
    const { mac, hostname, manufacturer } = req.body as {
      mac: string;
      hostname?: string;
      manufacturer?: string;
    };
    try {
      const newToken = `disc_${crypto.randomBytes(16).toString('hex')}`;
      const result = await db.query(
        `INSERT INTO devices
           (family_id, mac, hostname, manufacturer, platform, device_token, last_seen)
         VALUES ($1, $2, $3, $4, 'discovered', $5, NOW())
         ON CONFLICT (family_id, mac) DO UPDATE SET
           hostname = COALESCE(EXCLUDED.hostname, devices.hostname),
           manufacturer = COALESCE(EXCLUDED.manufacturer, devices.manufacturer),
           last_seen = NOW()
         RETURNING id, family_id, mac, hostname, manufacturer, platform,
                   last_seen, child_profile_id, (xmax = 0) AS inserted`,
        [req.device!.family_id, mac, hostname ?? null, manufacturer ?? null, newToken]
      );
      const row = result.rows[0];
      // Audit only on first sighting — repeated upserts are noise.
      if (row.inserted) {
        audit(req, 'device.discovered', {
          target_kind: 'device',
          target_id: row.id,
          metadata: {
            mac,
            hostname: hostname ?? null,
            manufacturer: manufacturer ?? null,
          },
        });
      }
      delete row.inserted;
      res.status(200).json(row);
    } catch (err) {
      console.error('device discovered failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// Cosmetic update of a device — rename (hostname) and/or assign to a
// child profile. The resolver doesn't read either field for filtering
// in v1; this is purely how the dashboard labels the row.
app.patch(
  '/api/v1/devices/:deviceId',
  requireParentAuth,
  requireVerifiedParent,
  validateBody(UpdateDeviceBody),
  async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const { hostname, child_profile_id } = req.body as {
      hostname?: string;
      child_profile_id?: string | null;
    };
    try {
      // Verify the device belongs to the parent's family.
      const owns = await db.query(
        'SELECT 1 FROM devices WHERE id = $1 AND family_id = $2',
        [deviceId, req.parent!.family_id],
      );
      if (owns.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      // If assigning to a child, verify the child belongs to the same
      // family — and refuse to assign to the synthetic Household child
      // (it's not a thing the dashboard should expose).
      if (child_profile_id) {
        const childOk = await db.query(
          `SELECT 1 FROM child_profiles
           WHERE id = $1 AND family_id = $2 AND is_household = false`,
          [child_profile_id, req.parent!.family_id],
        );
        if (childOk.rows.length === 0) {
          res.status(403).json({ error: 'child not in your family' });
          return;
        }
      }

      // hostname: undefined = leave alone, string = update.
      // child_profile_id: undefined = leave alone, null = unassign,
      // string = assign.
      await db.query(
        `UPDATE devices SET
           hostname = COALESCE($1, hostname),
           child_profile_id = CASE
             WHEN $2::boolean THEN $3::uuid
             ELSE child_profile_id
           END
         WHERE id = $4`,
        [
          hostname ?? null,
          child_profile_id !== undefined,
          child_profile_id ?? null,
          deviceId,
        ],
      );
      audit(req, 'device.updated', {
        target_kind: 'device',
        target_id: deviceId,
        metadata: { fields_changed: Object.keys(req.body ?? {}) },
      });
      res.json({ success: true });
    } catch (err) {
      console.error('device patch failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

app.get(
  '/api/v1/children/:childId/devices',
  requireParentForChild('childId'),
  async (req, res) => {
    const childId = req.params.childId as string;
    try {
      const result = await db.query(
        'SELECT id, platform, device_token, last_seen FROM devices WHERE child_profile_id = $1',
        [childId]
      );
      res.json(result.rows);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// Delete a device. Verified parent must own the device's family.
// Same manual-cleanup posture as DELETE /children — explicit deletes
// in a transaction so prod schema state can't break us.
//
// Cleanup contract:
//   - pairing_codes referencing this device or its keys: DELETED
//     (device_id direct ref OR api_key_id pointing at this device's keys)
//   - api_keys for this device:                          DELETED
//   - audit_log rows about this device:                  PRESERVED
//   - new audit row device.deleted:                      appended after COMMIT
//
// The hardware box holding the deleted api_key starts getting 401 on
// /resolve and /dns-query within seconds — intended for "decommission"
// and "reset hand-me-down box" flows.
app.delete(
  '/api/v1/devices/:deviceId',
  requireParentAuth,
  requireVerifiedParent,
  async (req, res) => {
    const deviceId = req.params.deviceId as string;
    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const owns = await client.query(
        `SELECT 1 FROM devices
         WHERE id = $1 AND family_id = $2`,
        [deviceId, req.parent!.family_id],
      );
      if (owns.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      // Pairing codes can reference EITHER the device directly OR an
      // api_key for this device. Catch both before deleting api_keys
      // (otherwise a pairing_code → api_key FK would block).
      await client.query(
        `DELETE FROM pairing_codes
         WHERE device_id = $1
            OR api_key_id IN (SELECT id FROM api_keys WHERE device_id = $1)`,
        [deviceId],
      );
      await client.query(
        'DELETE FROM api_keys WHERE device_id = $1',
        [deviceId],
      );
      await client.query(
        'DELETE FROM devices WHERE id = $1',
        [deviceId],
      );

      await client.query('COMMIT');

      audit(req, 'device.deleted', {
        target_kind: 'device',
        target_id: deviceId,
      });

      res.status(204).end();
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('device delete failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  },
);

// ---------- Heartbeat ----------
// Box-side health beacon. Updates devices.last_seen + last_health_payload.
// Authenticated with the device API key — same auth as /resolve. Privacy
// posture: payload is bounded by HeartbeatBody validation; no per-query
// data, no domains, no counts.
app.post(
  '/api/v1/devices/heartbeat',
  requireDeviceAuth,
  validateBody(HeartbeatBody),
  async (req, res) => {
    try {
      // Reset offline_alert_sent_at on every heartbeat — this is the
      // "the box is back" signal that lets the next 24h-silent stretch
      // trigger a fresh email instead of being suppressed forever after
      // the first alert. See src/workers/box-offline-watcher.ts.
      await db.query(
        `UPDATE devices
         SET last_seen = NOW(),
             last_health_payload = $2::jsonb,
             offline_alert_sent_at = NULL
         WHERE id = $1`,
        [req.device!.device_id, JSON.stringify(req.body ?? {})],
      );
      // Heartbeats fire every 5 min; we audit only every Nth to avoid
      // flooding audit_log. Sample roughly 1-in-12 (~hourly per device).
      if (Math.random() < 0.083) {
        audit(req, 'box.heartbeat', {
          target_kind: 'device',
          target_id: req.device!.device_id,
        });
      }
      res.status(204).end();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// ---------- Box network status ----------
// Box pushes its current DHCP-handoff state here after pairing,
// after every retry-network click, and on every periodic re-check.
// Stored on devices.network_status (JSONB) so the dashboard's box
// health panel can poll the GET endpoint below without going through
// the heartbeat shape.
app.post(
  '/api/v1/box/network-status',
  requireDeviceAuth,
  validateBody(BoxNetworkStatusBody),
  async (req, res) => {
    const body = req.body as Record<string, unknown>;
    try {
      const payload = {
        ...body,
        last_check_at:
          (body.last_check_at as string | undefined) ??
          new Date().toISOString(),
      };
      await db.query(
        `UPDATE devices
         SET network_status = $2::jsonb,
             last_seen = NOW()
         WHERE id = $1`,
        [req.device!.device_id, JSON.stringify(payload)],
      );

      const action: 'box.network.conflict' | 'box.network.reported' =
        body.conflict_detected === true
          ? 'box.network.conflict'
          : 'box.network.reported';
      audit(req, action, {
        target_kind: 'device',
        target_id: req.device!.device_id,
        metadata: {
          dhcp_active: body.dhcp_active,
          conflict_detected: body.conflict_detected,
          servers_seen: body.servers_seen ?? [],
        },
      });
      res.status(204).end();
    } catch (err) {
      console.error('box network-status post failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  },
);

// Dashboard-facing read of the box's last reported network status.
// Family-scoped — returns the most recently active device in the
// family that has a network_status payload (typically the one paired
// box). Empty 200 if the family has no box-shaped device yet.
app.get('/api/v1/box/network-status', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, network_status
       FROM devices
       WHERE family_id = $1 AND network_status IS NOT NULL
       ORDER BY last_seen DESC NULLS LAST
       LIMIT 1`,
      [req.parent!.family_id],
    );
    if (result.rows.length === 0) {
      res.json({
        dhcp_active: false,
        conflict_detected: false,
        leases_count: 0,
        last_check: null,
      });
      return;
    }
    const ns = result.rows[0].network_status as Record<string, unknown>;
    res.json({
      dhcp_active: Boolean(ns.dhcp_active),
      conflict_detected: Boolean(ns.conflict_detected),
      leases_count: Number(ns.leases_count ?? 0),
      last_check: ns.last_check_at ?? null,
      servers_seen: Array.isArray(ns.servers_seen) ? ns.servers_seen : [],
      box_ip: ns.box_ip ?? null,
      gateway_ip: ns.gateway_ip ?? null,
    });
  } catch (err) {
    console.error('box network-status get failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// Roll-up health view for the dashboard's Box Health panel — paired
// status, last heartbeat, network status, hardware id. Combines info
// from devices.last_seen + last_health_payload + network_status.
// Returns the family's most recently active "box" device (we treat
// the device created via /pairing/claim-by-code as the box; for v1
// each family has at most one).
app.get('/api/v1/box/health', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, device_token, last_seen, last_health_payload, network_status
       FROM devices
       WHERE family_id = $1
       ORDER BY last_seen DESC NULLS LAST
       LIMIT 1`,
      [req.parent!.family_id],
    );
    if (result.rows.length === 0) {
      res.json({
        paired: false,
        last_heartbeat: null,
        network_status: null,
        hardware_id: null,
      });
      return;
    }
    const row = result.rows[0];
    const ns = (row.network_status ?? null) as Record<string, unknown> | null;
    res.json({
      paired: true,
      last_heartbeat: row.last_seen,
      network_status: ns
        ? {
            dhcp_active: Boolean(ns.dhcp_active),
            conflict_detected: Boolean(ns.conflict_detected),
            leases_count: Number(ns.leases_count ?? 0),
          }
        : null,
      hardware_id: row.device_token,
    });
  } catch (err) {
    console.error('box health get failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------- Counters ----------
app.get(
  '/api/v1/children/:childId/blocks/today',
  requireParentForChild('childId'),
  async (req, res) => {
    const childId = req.params.childId as string;
    try {
      const total = await getDailyBlockCount(childId, new Date());
      res.json({
        child_profile_id: childId,
        day: new Date().toISOString().slice(0, 10),
        total,
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

app.get(
  '/api/v1/children/:childId/blocks/totals',
  requireParentForChild('childId'),
  async (req, res) => {
    const childId = req.params.childId as string;
    try {
      const totals = await getTotalsByCategory(childId);
      res.json({ child_profile_id: childId, totals });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// ---------- Family-scoped stats ----------
//
// GET /api/v1/stats/blocks?period=today|week|month
//
// Family-wide aggregate of block_counters, scoped to the authenticated
// parent's family via the child_profiles.family_id JOIN.
//
// In the v1 household model the resolver attributes every block to the
// family's synthetic Household child (see refactor/household-v1) — so
// `by_child` will typically contain a single Household entry until v2
// per-child resolution lands. Including it (rather than filtering it
// out) keeps the response shape stable across the v1→v2 transition:
// the dashboard can render whatever count(s) it gets.
app.get('/api/v1/stats/blocks', requireParentAuth, async (req, res) => {
  const period = (req.query.period ?? '').toString();
  // Period → days-back for the lower bound. `today` is exactly today
  // (one row max in by_day); week/month are the trailing 7/30 day
  // windows including today.
  const daysBack: Record<string, number> = {
    today: 0,
    week: 6,
    month: 29,
  };
  if (!(period in daysBack)) {
    res.status(400).json({
      error: 'invalid period',
      details: 'period must be one of: today, week, month',
    });
    return;
  }
  const days = daysBack[period];

  try {
    // Single CTE-driven query would be possible but four small focused
    // queries are easier to read, easier to index against, and don't
    // materially differ in cost on a counter table this size.
    const familyId = req.parent!.family_id;
    const dayLowerBound = `CURRENT_DATE - INTERVAL '${days} days'`;

    const totalQ = db.query(
      `SELECT COALESCE(SUM(b.count), 0)::int AS total
       FROM block_counters b
       JOIN child_profiles c ON c.id = b.child_profile_id
       WHERE c.family_id = $1 AND b.day >= ${dayLowerBound}`,
      [familyId],
    );

    const byCategoryQ = db.query(
      `SELECT b.category, COALESCE(SUM(b.count), 0)::int AS count
       FROM block_counters b
       JOIN child_profiles c ON c.id = b.child_profile_id
       WHERE c.family_id = $1 AND b.day >= ${dayLowerBound}
       GROUP BY b.category
       ORDER BY count DESC`,
      [familyId],
    );

    const byDayQ = db.query(
      `SELECT TO_CHAR(b.day, 'YYYY-MM-DD') AS date,
              COALESCE(SUM(b.count), 0)::int AS count
       FROM block_counters b
       JOIN child_profiles c ON c.id = b.child_profile_id
       WHERE c.family_id = $1 AND b.day >= ${dayLowerBound}
       GROUP BY b.day
       ORDER BY b.day ASC`,
      [familyId],
    );

    const byChildQ = db.query(
      `SELECT c.id AS child_id, c.name,
              COALESCE(SUM(b.count), 0)::int AS count
       FROM child_profiles c
       JOIN block_counters b ON b.child_profile_id = c.id
       WHERE c.family_id = $1 AND b.day >= ${dayLowerBound}
       GROUP BY c.id, c.name
       ORDER BY count DESC`,
      [familyId],
    );

    const [totalR, byCategoryR, byDayR, byChildR] = await Promise.all([
      totalQ,
      byCategoryQ,
      byDayQ,
      byChildQ,
    ]);

    res.json({
      period,
      total_blocks: totalR.rows[0]?.total ?? 0,
      by_category: byCategoryR.rows,
      by_day: byDayR.rows,
      by_child: byChildR.rows,
    });
  } catch (err) {
    console.error('stats/blocks failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

// ---------- Resolver / DoH ----------
app.post(
  '/api/v1/resolve',
  resolveLimiter,
  requireDeviceAuth,
  validateBody(ResolveBody),
  async (req, res) => {
    const { domain } = req.body as { domain: string };
    try {
      const { resolve } = await import('../resolver/index');
      const deviceTokenLookup = await db.query(
        'SELECT device_token FROM devices WHERE id = $1',
        [req.device!.device_id]
      );
      const deviceToken = deviceTokenLookup.rows[0]?.device_token;
      if (!deviceToken) {
        res.status(401).json({ error: 'device not found' });
        return;
      }
      const result = await resolve(domain, deviceToken);
      res.json(result);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

app.post(
  '/api/v1/analyze',
  resolveLimiter,
  requireDeviceAuth,
  validateBody(AnalyzeBody),
  async (req, res) => {
    const { url } = req.body as { url: string };
    try {
      const cacheKey = 'content:' + url;
      const { createClient } = await import('redis');
      const redis = createClient({ url: process.env.REDIS_URL });
      await redis.connect();
      const cached = await redis.get(cacheKey);
      if (cached) {
        await redis.disconnect();
        res.json(JSON.parse(cached));
        return;
      }
      const { fetchPageText, analyzeContent } = await import(
        '../resolver/content'
      );
      const text = await fetchPageText(url);
      const verdict = await analyzeContent(url, text);
      await redis.set(cacheKey, JSON.stringify(verdict), { EX: 3600 });
      await redis.disconnect();
      res.json(verdict);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

// DoH (RFC 8484) — Phase 4.1: gated behind a device API key so this
// can't be abused as an open recursive resolver / DDoS amplifier. The
// home box never uses DoH (it has UDP/53 on the LAN). DoH is intended
// for the v2 "off-network protection" flow where the device carries a
// per-device key. Browsers can't currently use this endpoint because
// the DoH spec doesn't pass auth headers — that's intentional for v1.
app.post('/dns-query', resolveLimiter, requireDeviceAuth, async (req, res) => {
  try {
    const { handleDoH } = await import('../resolver/doh');
    const result = await handleDoH(req.body);
    res.set('Content-Type', 'application/dns-message');
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

app.get('/dns-query', resolveLimiter, requireDeviceAuth, async (req, res) => {
  try {
    const dnsParam = req.query['dns'] as string;
    if (!dnsParam || dnsParam.length > 4096) {
      res.status(400).end();
      return;
    }
    const body = Buffer.from(dnsParam, 'base64');
    const { handleDoH } = await import('../resolver/doh');
    const result = await handleDoH(body);
    res.set('Content-Type', 'application/dns-message');
    res.send(result);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

// 404 for anything unmatched.
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Final error handler — must be last.
app.use(errorHandler);

export { app };
