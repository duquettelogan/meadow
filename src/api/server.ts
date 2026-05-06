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
} from './validation';
import { resolveLimiter, defaultLimiter } from './rate-limits';
import { audit } from '../audit/log';

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

// ---------- Family ----------
app.get('/api/v1/families/me', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, email, created_at FROM families WHERE id = $1',
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
      await db.query(
        `UPDATE devices
         SET last_seen = NOW(),
             last_health_payload = $2::jsonb
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
