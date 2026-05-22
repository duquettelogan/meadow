import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `boxsync-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniqueCode = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function makeFamily() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'boxsyncpw1234567' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

async function pairBox(token: string): Promise<{
  device_id: string;
  api_key: string;
  hardware_id: string;
}> {
  const hardware_id = uniqueHwId();
  const code = uniqueCode();
  await request(app)
    .post('/api/v1/pairing/register')
    .send({ hardware_id, pairing_code: code, platform: 'router' });
  const claim = await request(app)
    .post('/api/v1/pairing/claim-by-code')
    .set('Authorization', `Bearer ${token}`)
    .send({ pairing_code: code });
  expect(claim.status).toBe(200);
  const status = await request(app).get(
    `/api/v1/pairing/box-status/${hardware_id}`,
  );
  return {
    device_id: status.body.device_id,
    api_key: status.body.api_key,
    hardware_id,
  };
}

async function householdChildId(family_id: string): Promise<string> {
  const r = await db.query(
    'SELECT id FROM child_profiles WHERE family_id = $1 AND is_household = true',
    [family_id],
  );
  expect(r.rows.length).toBe(1);
  return r.rows[0].id;
}

describe('GET /api/v1/box/policy', () => {
  it('returns the family\'s household policy with a stable hash', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    const r = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${box.api_key}`);
    expect(r.status).toBe(200);
    expect(r.body.family_id).toBe(f.family_id);
    expect(r.body.household_child_id).toBe(await householdChildId(f.family_id));
    expect(r.body.policy_version).toMatch(/^[a-f0-9]{16}$/);
    // Default Household categories shipped by signup.
    expect(r.body.categories_blocked).toEqual(
      expect.arrayContaining(['malware', 'phishing', 'adult_content']),
    );
    expect(r.body.parent_blocklist).toEqual([]);
    expect(r.body.parent_allowlist).toEqual([]);
    expect(r.body.safe_search_enforce).toBe(true);
    expect(r.body.youtube_restrict).toBe(true);
    expect(r.body.blocklist_versions).toEqual({});
  });

  it('policy_version is stable across repeated reads with no changes', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    const a = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${box.api_key}`);
    const b = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${box.api_key}`);
    expect(a.body.policy_version).toBe(b.body.policy_version);
  });

  it('policy_version changes when the parent edits filter-policy', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    const before = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${box.api_key}`);

    await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ blocked_domains: ['example.com'] });

    const after = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${box.api_key}`);
    expect(after.body.policy_version).not.toBe(before.body.policy_version);
    expect(after.body.parent_blocklist).toEqual(['example.com']);
  });

  it('rejects requests with no api key (401)', async () => {
    const r = await request(app).get('/api/v1/box/policy');
    expect(r.status).toBe(401);
  });

  it('rejects requests with a malformed api key (401)', async () => {
    const r = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', 'Bearer not-a-real-key');
    expect(r.status).toBe(401);
  });

  it('is family-scoped — box A cannot see box B\'s policy', async () => {
    const a = await makeFamily();
    const aBox = await pairBox(a.token);
    await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ blocked_domains: ['only-in-family-a.example'] });

    const b = await makeFamily();
    const bBox = await pairBox(b.token);

    const aRes = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${aBox.api_key}`);
    const bRes = await request(app)
      .get('/api/v1/box/policy')
      .set('Authorization', `Bearer ${bBox.api_key}`);

    expect(aRes.body.parent_blocklist).toEqual(['only-in-family-a.example']);
    expect(bRes.body.parent_blocklist).toEqual([]);
    expect(aRes.body.family_id).not.toBe(bRes.body.family_id);
    expect(aRes.body.policy_version).not.toBe(bRes.body.policy_version);
  });
});

describe('POST /api/v1/box/blocks', () => {
  it('upserts events into block_counters and reports accepted/rejected', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const hh = await householdChildId(f.family_id);

    const tsIso = new Date().toISOString();
    const utcDay = tsIso.slice(0, 10); // YYYY-MM-DD UTC, matches server cast.
    const r = await request(app)
      .post('/api/v1/box/blocks')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({
        events: [
          {
            child_profile_id: hh,
            category: 'adult_content',
            count: 3,
            first_seen_at: tsIso,
            last_seen_at: tsIso,
          },
          {
            child_profile_id: hh,
            category: 'malware',
            count: 1,
            first_seen_at: tsIso,
            last_seen_at: tsIso,
          },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accepted: 2, rejected: 0 });

    const counters = await db.query(
      `SELECT category, count FROM block_counters
       WHERE child_profile_id = $1 AND day = $2::date
       ORDER BY category`,
      [hh, utcDay],
    );
    expect(counters.rows).toHaveLength(2);
    expect(counters.rows[0]).toMatchObject({ category: 'adult_content', count: 3 });
    expect(counters.rows[1]).toMatchObject({ category: 'malware', count: 1 });
  });

  it('aggregates across batches — second flush sums into the same row', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const hh = await householdChildId(f.family_id);
    const tsIso = new Date().toISOString();
    const utcDay = tsIso.slice(0, 10);
    const send = (count: number) =>
      request(app)
        .post('/api/v1/box/blocks')
        .set('Authorization', `Bearer ${box.api_key}`)
        .send({
          events: [
            {
              child_profile_id: hh,
              category: 'phishing',
              count,
              first_seen_at: tsIso,
              last_seen_at: tsIso,
            },
          ],
        });
    expect((await send(5)).status).toBe(200);
    expect((await send(7)).status).toBe(200);
    const row = await db.query(
      `SELECT count FROM block_counters
       WHERE child_profile_id = $1 AND day = $2::date AND category = 'phishing'`,
      [hh, utcDay],
    );
    expect(row.rows[0].count).toBe(12);
  });

  it('drops cross-family events silently (rejected count, accepted=0)', async () => {
    const a = await makeFamily();
    const aBox = await pairBox(a.token);
    const b = await makeFamily();
    const bHh = await householdChildId(b.family_id);
    const day = new Date().toISOString();

    const r = await request(app)
      .post('/api/v1/box/blocks')
      .set('Authorization', `Bearer ${aBox.api_key}`)
      .send({
        events: [
          {
            child_profile_id: bHh, // belongs to family B!
            category: 'malware',
            count: 99,
            first_seen_at: day,
            last_seen_at: day,
          },
        ],
      });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accepted: 0, rejected: 1 });

    // No row got written under B's child.
    const row = await db.query(
      `SELECT 1 FROM block_counters
       WHERE child_profile_id = $1 AND category = 'malware'`,
      [bHh],
    );
    expect(row.rows).toHaveLength(0);
  });

  it('uses last_seen_at::date for the day bucket', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const hh = await householdChildId(f.family_id);

    // Send a backfill for two days ago.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const utcDayTwoBack = twoDaysAgo.slice(0, 10);
    await request(app)
      .post('/api/v1/box/blocks')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({
        events: [
          {
            child_profile_id: hh,
            category: 'adult_content',
            count: 4,
            first_seen_at: twoDaysAgo,
            last_seen_at: twoDaysAgo,
          },
        ],
      });

    const row = await db.query(
      `SELECT count FROM block_counters
       WHERE child_profile_id = $1
         AND day = $2::date
         AND category = 'adult_content'`,
      [hh, utcDayTwoBack],
    );
    expect(row.rows[0]?.count).toBe(4);
  });

  it('rejects malformed body (400)', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const r = await request(app)
      .post('/api/v1/box/blocks')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ events: [{ category: 'oops' }] }); // missing required fields
    expect(r.status).toBe(400);
  });

  it('rejects empty events array (400)', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const r = await request(app)
      .post('/api/v1/box/blocks')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ events: [] });
    expect(r.status).toBe(400);
  });

  it('rejects requests with no api key (401)', async () => {
    const r = await request(app)
      .post('/api/v1/box/blocks')
      .send({ events: [] });
    expect(r.status).toBe(401);
  });
});

describe('GET /api/v1/box/device-children', () => {
  it('returns only mappings with both mac and child_profile_id set', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    // Seed a discovered device with a MAC, then assign it to a child.
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Emma' });
    expect(child.status).toBe(201);

    // /devices/discovered creates a row with mac populated and
    // child_profile_id null. Use device-key auth (the box's key).
    const disc = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ mac: 'aa:bb:cc:dd:ee:ff', hostname: 'kid-tablet' });
    expect(disc.status).toBe(200);

    // PATCH the discovered device to assign it to Emma.
    const patch = await request(app)
      .patch(`/api/v1/devices/${disc.body.id}`)
      .set('Authorization', `Bearer ${f.token}`)
      .send({ child_profile_id: child.body.id });
    expect(patch.status).toBe(200);

    const r = await request(app)
      .get('/api/v1/box/device-children')
      .set('Authorization', `Bearer ${box.api_key}`);
    expect(r.status).toBe(200);
    expect(r.body.mappings).toEqual([
      { mac: 'aa:bb:cc:dd:ee:ff', child_profile_id: child.body.id },
    ]);
  });

  it('returns an empty list when the family has no per-MAC assignments', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const r = await request(app)
      .get('/api/v1/box/device-children')
      .set('Authorization', `Bearer ${box.api_key}`);
    expect(r.status).toBe(200);
    expect(r.body.mappings).toEqual([]);
  });

  it('is family-scoped', async () => {
    const a = await makeFamily();
    const aBox = await pairBox(a.token);
    const aChild = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ name: 'AKid' });
    const aDisc = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${aBox.api_key}`)
      .send({ mac: '11:22:33:44:55:66' });
    await request(app)
      .patch(`/api/v1/devices/${aDisc.body.id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ child_profile_id: aChild.body.id });

    // Family B's box should NOT see family A's mappings.
    const b = await makeFamily();
    const bBox = await pairBox(b.token);
    const r = await request(app)
      .get('/api/v1/box/device-children')
      .set('Authorization', `Bearer ${bBox.api_key}`);
    expect(r.body.mappings).toEqual([]);
  });

  it('rejects requests with no api key (401)', async () => {
    const r = await request(app).get('/api/v1/box/device-children');
    expect(r.status).toBe(401);
  });
});

describe('POST /api/v1/box/heartbeat (alias of /devices/heartbeat)', () => {
  it('accepts the same body shape and updates devices.last_seen + last_health_payload', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    const r = await request(app)
      .post('/api/v1/box/heartbeat')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({
        ts: Math.floor(Date.now() / 1000),
        uptime_seconds: 1234,
        free_memory_mb: 256,
        box_version: '1.0.0',
      });
    expect(r.status).toBe(204);

    const row = await db.query(
      'SELECT last_seen, last_health_payload FROM devices WHERE id = $1',
      [box.device_id],
    );
    expect(row.rows[0].last_seen).toBeTruthy();
    expect(row.rows[0].last_health_payload.uptime_seconds).toBe(1234);
    expect(row.rows[0].last_health_payload.box_version).toBe('1.0.0');
  });

  it('resets offline_alert_sent_at on heartbeat (same as the legacy path)', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    await db.query(
      `UPDATE devices SET offline_alert_sent_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [box.device_id],
    );

    const r = await request(app)
      .post('/api/v1/box/heartbeat')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ ts: Math.floor(Date.now() / 1000) });
    expect(r.status).toBe(204);

    const row = await db.query(
      'SELECT offline_alert_sent_at FROM devices WHERE id = $1',
      [box.device_id],
    );
    expect(row.rows[0].offline_alert_sent_at).toBeNull();
  });

  it('rejects requests with no api key (401)', async () => {
    const r = await request(app)
      .post('/api/v1/box/heartbeat')
      .send({ ts: Math.floor(Date.now() / 1000) });
    expect(r.status).toBe(401);
  });
});

describe('POST /api/v1/box/discovered (alias of /devices/discovered)', () => {
  it('upserts the device row on the box\'s family', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    const r = await request(app)
      .post('/api/v1/box/discovered')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ mac: '22:33:44:55:66:77', hostname: 'kid-laptop' });
    expect(r.status).toBe(200);
    expect(r.body.mac).toBe('22:33:44:55:66:77');
    expect(r.body.hostname).toBe('kid-laptop');
    expect(r.body.family_id).toBe(f.family_id);
    expect(r.body.platform).toBe('discovered');
  });

  it('is idempotent on (family_id, mac) — second call updates instead of insert', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    const a = await request(app)
      .post('/api/v1/box/discovered')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ mac: '33:33:33:33:33:33' });
    const b = await request(app)
      .post('/api/v1/box/discovered')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ mac: '33:33:33:33:33:33', hostname: 'now-with-name' });
    expect(a.body.id).toBe(b.body.id);
    expect(b.body.hostname).toBe('now-with-name');
  });

  it('rejects requests with no api key (401)', async () => {
    const r = await request(app)
      .post('/api/v1/box/discovered')
      .send({ mac: 'aa:aa:aa:aa:aa:aa' });
    expect(r.status).toBe(401);
  });
});
