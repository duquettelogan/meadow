import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
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
// Email-verification gate: creating new child profiles is one of the two
// touchpoints that materially expand the account (the other is pairing
// claim). Unverified parents get a 403 — the dashboard should surface
// "verify your email first" UX and offer the /resend-verification button.
app.post(
  '/api/v1/children',
  requireParentAuth,
  requireVerifiedParent,
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
app.get('/api/v1/children', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT c.id, c.family_id, c.name, c.tier, c.created_at,
              COALESCE(SUM(b.count), 0)::int AS blocks_today
       FROM child_profiles c
       LEFT JOIN block_counters b
         ON b.child_profile_id = c.id
        AND b.day = CURRENT_DATE
       WHERE c.family_id = $1
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
// CASCADE behavior (set in migrate-007):
//   - filter_policies row for this child:  CASCADE-deleted
//   - block_counters rows for this child:  CASCADE-deleted (already)
//   - devices.child_profile_id pointing here: SET NULL (devices stay
//     in the family, become unassigned, parent can re-assign or delete)
//   - audit_log rows about this child:     PRESERVED (no FK by design)
app.delete(
  '/api/v1/children/:childId',
  requireParentAuth,
  requireVerifiedParent,
  async (req, res) => {
    const childId = req.params.childId as string;
    try {
      const result = await db.query(
        `DELETE FROM child_profiles
         WHERE id = $1 AND family_id = $2
         RETURNING id`,
        [childId, req.parent!.family_id],
      );
      if (result.rows.length === 0) {
        // Conflates "doesn't exist" and "not in your family" — same
        // response prevents existence-probing across families.
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      audit(req, 'child.deleted', {
        target_kind: 'child_profile',
        target_id: childId,
      });
      res.status(204).end();
    } catch (err) {
      console.error('child delete failed:', err);
      res.status(500).json({ error: 'internal server error' });
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
app.get('/api/v1/devices', requireParentAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT d.id, d.platform, d.last_seen,
              d.child_profile_id, c.name AS child_name
       FROM devices d
       LEFT JOIN child_profiles c ON c.id = d.child_profile_id
       WHERE d.family_id = $1
       ORDER BY d.last_seen ASC`,
      [req.parent!.family_id]
    );
    res.json({ devices: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

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
// CASCADE behavior (FKs set in migrate-003 / migrate-004):
//   - api_keys for this device:        CASCADE-deleted
//   - pairing_codes.device_id:         CASCADE-deleted
//   - pairing_codes.api_key_id:        CASCADE-deleted
//   - audit_log rows about this device: PRESERVED (no FK by design)
app.delete(
  '/api/v1/devices/:deviceId',
  requireParentAuth,
  requireVerifiedParent,
  async (req, res) => {
    const deviceId = req.params.deviceId as string;
    try {
      const result = await db.query(
        `DELETE FROM devices
         WHERE id = $1 AND family_id = $2
         RETURNING id`,
        [deviceId, req.parent!.family_id],
      );
      if (result.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      audit(req, 'device.deleted', {
        target_kind: 'device',
        target_id: deviceId,
      });
      res.status(204).end();
    } catch (err) {
      console.error('device delete failed:', err);
      res.status(500).json({ error: 'internal server error' });
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
