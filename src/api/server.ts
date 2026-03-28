import express from 'express';
import cors from 'cors';
import { db } from '../db/connection';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meadow-api' });
});

app.post('/api/v1/families', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  try {
    const result = await db.query(
      `INSERT INTO families (email) VALUES ($1) RETURNING id, email, created_at`,
      [email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'email already exists' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/families/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await db.query(
      `SELECT id, email, created_at FROM families WHERE id = $1`,
      [id]
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

app.post('/api/v1/families/:familyId/children', async (req, res) => {
  const { familyId } = req.params;
  const { name, age } = req.body;
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  try {
    const child = await db.query(
      `INSERT INTO child_profiles (family_id, name, age)
       VALUES ($1, $2, $3)
       RETURNING id, family_id, name, age, protection_level, created_at`,
      [familyId, name, age]
    );
    await db.query(
      `INSERT INTO filter_policies (child_profile_id) VALUES ($1)`,
      [child.rows[0].id]
    );
    res.status(201).json(child.rows[0]);
  } catch (err: any) {
    if (err.code === '23503') {
      res.status(404).json({ error: 'family not found' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/children/:childId', async (req, res) => {
  const { childId } = req.params;
  try {
    const result = await db.query(
      `SELECT 
        c.id, c.family_id, c.name, c.age, c.protection_level,
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
});

app.post('/api/v1/devices/register', async (req, res) => {
  const { family_id, child_profile_id, platform, device_token } = req.body;
  if (!family_id || !platform || !device_token) {
    res.status(400).json({ error: 'family_id, platform and device_token are required' });
    return;
  }
  try {
    const result = await db.query(
      `INSERT INTO devices (family_id, child_profile_id, platform, device_token, last_seen)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (device_token)
       DO UPDATE SET last_seen = NOW(), child_profile_id = $2
       RETURNING id, family_id, child_profile_id, platform, last_seen`,
      [family_id, child_profile_id, platform, device_token]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23503') {
      res.status(404).json({ error: 'family or child profile not found' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.post('/api/v1/resolve', async (req, res) => {
  const { domain, device_token } = req.body;
  if (!domain || !device_token) {
    res.status(400).json({ error: 'domain and device_token are required' });
    return;
  }
  try {
    const { resolve } = await import('../resolver/index');
    const result = await resolve(domain, device_token);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});
app.post('/api/v1/analyze', async (req, res) => {
  const { url, device_token } = req.body;

  if (!url || !device_token) {
    res.status(400).json({ error: 'url and device_token are required' });
    return;
  }

  try {
    const cacheKey = `content:${url}`;
    const { createClient } = await import('redis');
    const redis = createClient({ url: process.env.REDIS_URL });
    await redis.connect();

    const cached = await redis.get(cacheKey);
    if (cached) {
      await redis.disconnect();
      res.json(JSON.parse(cached));
      return;
    }

    const { fetchPageText, analyzeContent } = await import('../resolver/content');
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

app.patch('/api/v1/children/:childId/policy', async (req, res) => {
  const { childId } = req.params;
  const {
    blocked_categories,
    allowed_domains,
    blocked_domains,
    safe_search_enforce,
    restricted_mode,
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
        restricted_mode ?? null,
        childId,
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/children/:childId/alerts', async (req, res) => {
  const { childId } = req.params;

  try {
    const result = await db.query(
      `SELECT domain, verdict, category, reason, latency_ms, resolved_at
       FROM dns_events
       WHERE child_profile_id = $1
       AND verdict = 'block'
       ORDER BY resolved_at DESC
       LIMIT 50`,
      [childId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/children/:childId/devices', async (req, res) => {
  const { childId } = req.params;

  try {
    const result = await db.query(
      `SELECT id, platform, device_token, last_seen
       FROM devices
       WHERE child_profile_id = $1`,
      [childId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

export { app };