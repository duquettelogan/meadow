import express from 'express';
import cors from 'cors';
import { db } from '../db/connection';
import { getDailyBlockCount, getTotalsByCategory } from '../db/counters';
import { authRouter } from './auth-routes';
import {
  requireParentAuth,
  requireParentForChild,
  requireDeviceAuth,
} from '../auth/middleware';

const app = express();
app.use(cors());
app.use(express.json());
app.use('/dns-query', express.raw({ type: 'application/dns-message' }));

// ---------- Public ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meadow-api' });
});

// Auth routes (signup, login, /me, device keys). Each route inside enforces
// its own auth requirements.
app.use('/api/v1/auth', authRouter);

// ---------- Family (parent-authed, scoped to own family) ----------
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

// ---------- Children (no age, just tier) ----------
app.post('/api/v1/children', requireParentAuth, async (req, res) => {
  const { name, tier } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
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
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get(
  '/api/v1/children/:childId',
  requireParentForChild('childId'),
  async (req, res) => {
    const { childId } = req.params;
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
  async (req, res) => {
    const { childId } = req.params;
    const {
      blocked_categories,
      allowed_domains,
      blocked_domains,
      safe_search_enforce,
      youtube_restrict,
    } = req.body;
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

// ---------- Devices (parent-authed registration) ----------
app.post('/api/v1/devices/register', requireParentAuth, async (req, res) => {
  const { child_profile_id, platform, device_token } = req.body;
  if (!platform || !device_token) {
    res
      .status(400)
      .json({ error: 'platform and device_token are required' });
    return;
  }

  try {
    // Validate child belongs to this family if provided.
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
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get(
  '/api/v1/children/:childId/devices',
  requireParentForChild('childId'),
  async (req, res) => {
    const { childId } = req.params;
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

// ---------- Counters (parent-authed, aggregated only) ----------
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

// ---------- Resolver / DoH (device-authed) ----------
app.post('/api/v1/resolve', requireDeviceAuth, async (req, res) => {
  const { domain } = req.body;
  if (!domain) {
    res.status(400).json({ error: 'domain is required' });
    return;
  }
  try {
    const { resolve } = await import('../resolver/index');
    // Use the authenticated device's stored device_token for policy lookup.
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
});

app.post('/api/v1/analyze', requireDeviceAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) {
    res.status(400).json({ error: 'url is required' });
    return;
  }
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
});

// DoH stays public — DNS-over-HTTPS protocol can't easily carry custom auth
// headers from arbitrary clients. Network position protects this endpoint
// (only the local network reaches it, by firewall rule on the Pi).
app.post('/dns-query', async (req, res) => {
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

app.get('/dns-query', async (req, res) => {
  try {
    const dnsParam = req.query['dns'] as string;
    if (!dnsParam) {
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

export { app };
