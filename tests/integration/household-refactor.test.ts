import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `hh-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniqueMac = () => {
  // Locally administered, unicast — won't collide with real hardware.
  // 02:xx:xx:xx:xx:xx (counter+random for uniqueness across tests).
  const r = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `02:${r()}:${r()}:${r()}:${counter
    .toString(16)
    .padStart(2, '0')}:${r()}`;
};

async function makeVerifiedParent() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'householdpw12345' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
    parent_id: sig.body.parent.id as string,
  };
}

// Box-originated v1 pairing flow: box generates code, registers with
// API, parent reads code from meadow.local and POSTs claim-by-code,
// box polls box-status to receive the api_key.
const uniquePairingCodeForTest = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function pairBoxFor(token: string): Promise<string> {
  const hardware_id = uniqueHwId();
  const code = uniquePairingCodeForTest();

  const reg = await request(app)
    .post('/api/v1/pairing/register')
    .send({ hardware_id, pairing_code: code, platform: 'router' });
  expect(reg.status).toBe(201);

  const claim = await request(app)
    .post('/api/v1/pairing/claim-by-code')
    .set('Authorization', `Bearer ${token}`)
    .send({ pairing_code: code });
  expect(claim.status).toBe(200);

  const status = await request(app).get(
    `/api/v1/pairing/box-status/${hardware_id}`,
  );
  expect(status.status).toBe(200);
  expect(status.body.status).toBe('ready');
  return status.body.api_key as string;
}

describe('signup creates Household child + filter_policy', () => {
  it('exactly one is_household=true child per family, with a default policy', async () => {
    const { family_id } = await makeVerifiedParent();

    const hh = await db.query(
      `SELECT id, name, tier FROM child_profiles
       WHERE family_id = $1 AND is_household = true`,
      [family_id],
    );
    expect(hh.rows.length).toBe(1);
    expect(hh.rows[0].name).toBe('Household');
    expect(hh.rows[0].tier).toBe('standard');

    const policy = await db.query(
      `SELECT blocked_categories, allowed_domains, blocked_domains,
              safe_search_enforce, youtube_restrict
       FROM filter_policies WHERE child_profile_id = $1`,
      [hh.rows[0].id],
    );
    expect(policy.rows.length).toBe(1);

    // Safety-floor defaults: malware + phishing + adult_content ON;
    // every other category ships off so parents opt in deliberately
    // (social_media, gambling, gaming, etc.).
    const cats = policy.rows[0].blocked_categories;
    const list: string[] = Array.isArray(cats) ? cats : JSON.parse(cats);
    expect(list).toEqual(
      expect.arrayContaining(['malware', 'phishing', 'adult_content']),
    );
    expect(list.length).toBe(3);

    // Other defaults still come from the schema.
    expect(policy.rows[0].safe_search_enforce).toBe(true);
    expect(policy.rows[0].youtube_restrict).toBe(true);
    const allowed = policy.rows[0].allowed_domains;
    const blocked = policy.rows[0].blocked_domains;
    expect(Array.isArray(allowed) ? allowed : JSON.parse(allowed)).toEqual([]);
    expect(Array.isArray(blocked) ? blocked : JSON.parse(blocked)).toEqual([]);
  });
});

describe('GET /api/v1/children excludes the Household child', () => {
  it('lists only non-household children', async () => {
    const { token } = await makeVerifiedParent();

    const empty = await request(app)
      .get('/api/v1/children')
      .set('Authorization', `Bearer ${token}`);
    expect(empty.status).toBe(200);
    expect(empty.body.children).toEqual([]); // Household is hidden

    await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma' });

    const one = await request(app)
      .get('/api/v1/children')
      .set('Authorization', `Bearer ${token}`);
    expect(one.body.children).toHaveLength(1);
    expect(one.body.children[0].name).toBe('Emma');
  });
});

describe('Box-originated pairing binds device to family but NOT to a child', () => {
  it('claim-by-code creates device with child_profile_id null + stamps pairing_codes.family_id', async () => {
    const { token } = await makeVerifiedParent();
    const hardware_id = uniqueHwId();
    const code = uniquePairingCodeForTest();

    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });

    const claim = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: code });
    expect(claim.status).toBe(200);
    expect(claim.body.family_id).toBeTruthy();

    const dev = await db.query(
      'SELECT family_id, child_profile_id FROM devices WHERE id = $1',
      [claim.body.device_id],
    );
    expect(dev.rows[0].child_profile_id).toBeNull();

    const pc = await db.query(
      'SELECT family_id FROM pairing_codes WHERE code = $1',
      [code],
    );
    expect(pc.rows[0].family_id).toBe(claim.body.family_id);
  });
});

describe('POST /api/v1/devices/discovered', () => {
  it('UPSERT is idempotent on (family_id, mac)', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const mac = uniqueMac();

    const a = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac, hostname: 'living-room-tv', manufacturer: 'Sony Corp' });
    expect(a.status).toBe(200);
    const firstId = a.body.id;
    expect(a.body.mac).toBe(mac.toLowerCase());
    expect(a.body.hostname).toBe('living-room-tv');

    // Second call with same (family_id, mac): same row, last_seen bumps.
    const b = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac, hostname: 'still-the-tv' });
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(firstId);
    expect(b.body.hostname).toBe('still-the-tv');

    const rows = await db.query(
      'SELECT count(*)::int AS c FROM devices WHERE mac = $1',
      [mac.toLowerCase()],
    );
    expect(rows.rows[0].c).toBe(1);
  });

  it('preserves prior hostname/manufacturer if subsequent post omits them', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const mac = uniqueMac();

    await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac, hostname: 'first-name', manufacturer: 'Acme Inc' });

    const next = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac });
    expect(next.body.hostname).toBe('first-name');
    expect(next.body.manufacturer).toBe('Acme Inc');
  });

  it('two families can independently track the same MAC', async () => {
    const a = await makeVerifiedParent();
    const aKey = await pairBoxFor(a.token);
    const b = await makeVerifiedParent();
    const bKey = await pairBoxFor(b.token);
    const mac = uniqueMac();

    const ra = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${aKey}`)
      .send({ mac, hostname: 'house-a-iphone' });
    const rb = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${bKey}`)
      .send({ mac, hostname: 'house-b-iphone' });

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(ra.body.id).not.toBe(rb.body.id);
    expect(ra.body.family_id).toBe(a.family_id);
    expect(rb.body.family_id).toBe(b.family_id);
  });

  it('rejects malformed MAC', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const r = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac: 'not-a-mac' });
    expect(r.status).toBe(400);
  });

  it('requires device api key (not parent JWT)', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${token}`) // parent JWT, not mk_
      .send({ mac: uniqueMac() });
    expect(r.status).toBe(401);
  });
});

describe('GET/PUT /api/v1/filter-policy (family-scoped Household)', () => {
  it('GET returns the Household policy with default values', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .get('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.blocked_categories)).toBe(true);
    expect(Array.isArray(r.body.allowed_domains)).toBe(true);
    expect(Array.isArray(r.body.blocked_domains)).toBe(true);
    expect(typeof r.body.safe_search_enforce).toBe('boolean');
    expect(typeof r.body.youtube_restrict).toBe('boolean');
  });

  it('PUT updates fields and the changes are visible on next GET', async () => {
    const { token } = await makeVerifiedParent();
    const put = await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({
        blocked_categories: ['gambling', 'social_media'],
        allowed_domains: ['khanacademy.org'],
        safe_search_enforce: true,
      });
    expect(put.status).toBe(200);

    const r = await request(app)
      .get('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.blocked_categories).toEqual(
      expect.arrayContaining(['gambling', 'social_media']),
    );
    expect(r.body.allowed_domains).toEqual(['khanacademy.org']);
    expect(r.body.safe_search_enforce).toBe(true);
  });

  it('PUT requires verified email', async () => {
    const email = uniqueEmail();
    const sig = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'unverpw12345' });
    // not verifying

    const r = await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${sig.body.token}`)
      .send({ safe_search_enforce: true });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'email_not_verified' });
  });

  it('PUT is family-scoped — parent A cannot affect parent B', async () => {
    const a = await makeVerifiedParent();
    const b = await makeVerifiedParent();

    await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ allowed_domains: ['only-a-allowed.example'] });

    const bRead = await request(app)
      .get('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${b.token}`);
    expect(bRead.body.allowed_domains).toEqual([]);
  });
});

describe('PATCH /api/v1/devices/:id (cosmetic rename + assign-to-child)', () => {
  it('assigns a device to a child without changing DNS behavior', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const mac = uniqueMac();
    const dev = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac });

    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma' });

    const patch = await request(app)
      .patch(`/api/v1/devices/${dev.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ hostname: 'emmas-tablet', child_profile_id: child.body.id });
    expect(patch.status).toBe(200);

    const after = await db.query(
      'SELECT hostname, child_profile_id FROM devices WHERE id = $1',
      [dev.body.id],
    );
    expect(after.rows[0].hostname).toBe('emmas-tablet');
    expect(after.rows[0].child_profile_id).toBe(child.body.id);
  });

  it('refuses to assign to the synthetic Household child', async () => {
    const { token, family_id } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const dev = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac: uniqueMac() });

    const hh = await db.query(
      `SELECT id FROM child_profiles
       WHERE family_id = $1 AND is_household = true`,
      [family_id],
    );

    const patch = await request(app)
      .patch(`/api/v1/devices/${dev.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ child_profile_id: hh.rows[0].id });
    expect(patch.status).toBe(403);
  });

  it('refuses to assign to another family\'s child', async () => {
    const a = await makeVerifiedParent();
    const aKey = await pairBoxFor(a.token);
    const aDev = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${aKey}`)
      .send({ mac: uniqueMac() });

    const b = await makeVerifiedParent();
    const bChild = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ name: 'Bobby' });

    const patch = await request(app)
      .patch(`/api/v1/devices/${aDev.body.id}`)
      .set('Authorization', `Bearer ${a.token}`)
      .send({ child_profile_id: bChild.body.id });
    expect(patch.status).toBe(403);
  });

  it('refuses to patch another family\'s device', async () => {
    const a = await makeVerifiedParent();
    const aKey = await pairBoxFor(a.token);
    const aDev = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${aKey}`)
      .send({ mac: uniqueMac() });

    const b = await makeVerifiedParent();
    const patch = await request(app)
      .patch(`/api/v1/devices/${aDev.body.id}`)
      .set('Authorization', `Bearer ${b.token}`)
      .send({ hostname: 'attempted-rename' });
    expect(patch.status).toBe(403);
  });

  it('child_profile_id: null unassigns', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Charlie' });
    const dev = await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac: uniqueMac() });

    await request(app)
      .patch(`/api/v1/devices/${dev.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ child_profile_id: child.body.id });

    await request(app)
      .patch(`/api/v1/devices/${dev.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ child_profile_id: null });

    const after = await db.query(
      'SELECT child_profile_id FROM devices WHERE id = $1',
      [dev.body.id],
    );
    expect(after.rows[0].child_profile_id).toBeNull();
  });
});

describe('GET /api/v1/devices returns enriched fields', () => {
  it('includes hostname / manufacturer / mac / last_seen', async () => {
    const { token } = await makeVerifiedParent();
    const apiKey = await pairBoxFor(token);
    const mac = uniqueMac();
    await request(app)
      .post('/api/v1/devices/discovered')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ mac, hostname: 'kitchen-echo', manufacturer: 'Amazon' });

    const list = await request(app)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    const found = list.body.devices.find((d: any) => d.mac === mac.toLowerCase());
    expect(found).toBeTruthy();
    expect(found.hostname).toBe('kitchen-echo');
    expect(found.manufacturer).toBe('Amazon');
    expect(found.last_seen).toBeTruthy();
  });
});
