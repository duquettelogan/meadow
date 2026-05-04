import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { db } from '../db/connection';
import { getDailyBlockCount, getTotalsByCategory } from '../db/counters';
import { authRouter } from './auth-routes';
import {
  requireParentAuth,
  requireParentForChild,
  requireDeviceAuth,
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
} from './validation';
import { resolveLimiter, defaultLimiter } from './rate-limits';

const app = express();

// ---------- Security middleware ----------
app.use(helmet({
  // The DoH endpoint serves binary DNS messages, not HTML — relax CSP for it.
  // Everything else gets the full helmet treatment.
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
}));

// CORS: only allow configured dashboard origins. Default to localhost dev.
const allowedOrigins = (
  process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3001'
).split(',').map(s => s.trim()).filter(Boolean);

app.use(
  cors({
    origin: (origin, cb) => {
      // Allow requests with no origin (curl, mobile apps, server-to-server).
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // Disallowed origins: don't error, just don't set the CORS header.
      // The browser will block the response client-side. Throwing an error
      // here breaks non-browser clients (curl, health checks, etc.) entirely.
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
      res.status(201).json(child.rows[0]);
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
      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
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
      res.status(201).json(result.rows[0]);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
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
// Higher rate limit on resolve — DNS lookups are frequent.
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

// DoH stays public — DNS-over-HTTPS clients can't carry custom auth headers.
// Network-layer protection (firewall to local network only) is the right
// defense here, not application-layer auth.
app.post('/dns-query', resolveLimiter, async (req, res) => {
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

app.get('/dns-query', resolveLimiter, async (req, res) => {
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
