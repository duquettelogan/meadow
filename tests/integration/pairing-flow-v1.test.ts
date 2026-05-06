import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `pv1-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;

// Pull from the high range so test fixtures don't collide with real
// box-generated codes elsewhere in the suite.
const uniqueCode = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function makeVerifiedParent() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'pairv1pw12345' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

describe('POST /api/v1/pairing/register', () => {
  it('anonymous; accepts {hardware_id, pairing_code}; 201', async () => {
    const r = await request(app)
      .post('/api/v1/pairing/register')
      .send({
        hardware_id: uniqueHwId(),
        pairing_code: uniqueCode(),
        platform: 'router',
      });
    expect(r.status).toBe(201);
    expect(r.body.expires_in_seconds).toBeGreaterThan(0);
  });

  it('rejects invalid hardware_id format (400)', async () => {
    const r = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: 'short', pairing_code: uniqueCode() });
    expect(r.status).toBe(400);
  });

  it('rejects invalid pairing_code format (400)', async () => {
    const r = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: uniqueHwId(), pairing_code: 'abcdefgh' });
    expect(r.status).toBe(400);
  });

  it('same (hardware_id, code) is idempotent — refreshes expires_at', async () => {
    const hardware_id = uniqueHwId();
    const code = uniqueCode();
    const a = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });
    expect(b.status).toBe(201);

    const rows = await db.query(
      'SELECT count(*)::int AS c FROM pairing_codes WHERE code = $1',
      [code],
    );
    expect(rows.rows[0].c).toBe(1);
  });

  it('different hardware_id colliding on code → 409', async () => {
    const code = uniqueCode();
    const a = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: uniqueHwId(), pairing_code: code });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: uniqueHwId(), pairing_code: code });
    expect(b.status).toBe(409);
  });
});

describe('POST /api/v1/pairing/claim-by-code', () => {
  it('verified parent claims an unclaimed code → 200', async () => {
    const { token, family_id } = await makeVerifiedParent();
    const hardware_id = uniqueHwId();
    const code = uniqueCode();

    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });

    const r = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: code });
    expect(r.status).toBe(200);
    expect(r.body.family_id).toBe(family_id);
    expect(r.body.device_id).toBeTruthy();

    // pairing_codes row stamped with family_id + claimed_at.
    const row = await db.query(
      'SELECT family_id, claimed_at, plaintext_key FROM pairing_codes WHERE code = $1',
      [code],
    );
    expect(row.rows[0].family_id).toBe(family_id);
    expect(row.rows[0].claimed_at).toBeTruthy();
    expect(typeof row.rows[0].plaintext_key).toBe('string');
  });

  it('unknown code → 404', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: '9876-5432' });
    expect(r.status).toBe(404);
  });

  it('already-claimed code → 409', async () => {
    const a = await makeVerifiedParent();
    const code = uniqueCode();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: uniqueHwId(), pairing_code: code });

    await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ pairing_code: code });

    // Second parent (or same parent retry) → 409.
    const second = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ pairing_code: code });
    expect(second.status).toBe(409);
  });

  it('expired code → 410', async () => {
    const { token } = await makeVerifiedParent();
    const hardware_id = uniqueHwId();
    const code = uniqueCode();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });

    // Force expiry directly in DB.
    await db.query(
      `UPDATE pairing_codes SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE code = $1`,
      [code],
    );

    const r = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: code });
    expect(r.status).toBe(410);
  });

  it('requires auth (401 without token)', async () => {
    const r = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .send({ pairing_code: '1234-5678' });
    expect(r.status).toBe(401);
  });

  it('requires verified email (403 email_not_verified)', async () => {
    const sig = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'unverpw12345' });

    const code = uniqueCode();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id: uniqueHwId(), pairing_code: code });

    const r = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${sig.body.token}`)
      .send({ pairing_code: code });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'email_not_verified' });
  });
});

describe('GET /api/v1/pairing/box-status/:hardware_id', () => {
  it('404 when no registration exists', async () => {
    const r = await request(app).get(
      `/api/v1/pairing/box-status/${uniqueHwId()}`,
    );
    expect(r.status).toBe(404);
  });

  it('200 pending while unclaimed', async () => {
    const hardware_id = uniqueHwId();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: uniqueCode() });

    const r = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: 'pending' });
  });

  it('200 ready once claimed; api_key delivered single-shot', async () => {
    const { token } = await makeVerifiedParent();
    const hardware_id = uniqueHwId();
    const code = uniqueCode();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });

    await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: code });

    const a = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(a.status).toBe(200);
    expect(a.body.status).toBe('ready');
    expect(a.body.api_key).toMatch(/^mk_[a-f0-9]+$/);
    expect(a.body.device_id).toBeTruthy();

    const apiKey = a.body.api_key;
    const deviceId = a.body.device_id;

    // Second poll → 410, key already revealed.
    const b = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(b.status).toBe(410);
    expect(b.body.status).toBe('already_retrieved');

    // The delivered key actually works against /resolve.
    const resolve = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'example.com' });
    expect(resolve.status).toBe(200);
    expect(deviceId).toBeTruthy();
  });

  it('410 expired when registration timed out unclaimed', async () => {
    const hardware_id = uniqueHwId();
    const code = uniqueCode();
    await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });

    await db.query(
      `UPDATE pairing_codes SET expires_at = NOW() - INTERVAL '1 minute'
       WHERE code = $1`,
      [code],
    );

    const r = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(r.status).toBe(410);
    expect(r.body.status).toBe('expired');
  });

  it('400 on malformed hardware_id in path', async () => {
    const r = await request(app).get('/api/v1/pairing/box-status/short');
    expect(r.status).toBe(400);
  });
});

describe('full e2e: register → claim-by-code → poll → resolve', () => {
  it('walks the box-originated pairing flow end-to-end', async () => {
    const { token, family_id } = await makeVerifiedParent();
    const hardware_id = uniqueHwId();
    const code = uniqueCode();

    // Box registers.
    const reg = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: code });
    expect(reg.status).toBe(201);

    // Box polls — pending.
    const pending = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(pending.body).toEqual({ status: 'pending' });

    // Parent reads the code off http://meadow.local and claims.
    const claim = await request(app)
      .post('/api/v1/pairing/claim-by-code')
      .set('Authorization', `Bearer ${token}`)
      .send({ pairing_code: code });
    expect(claim.status).toBe(200);
    expect(claim.body.family_id).toBe(family_id);

    // Box polls again — ready.
    const ready = await request(app).get(
      `/api/v1/pairing/box-status/${hardware_id}`,
    );
    expect(ready.body.status).toBe('ready');

    // Box uses the key.
    const resolve = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${ready.body.api_key}`)
      .send({ domain: 'example.com' });
    expect(resolve.status).toBe(200);
  });
});
