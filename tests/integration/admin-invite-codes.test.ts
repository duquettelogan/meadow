import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `inv-${Date.now()}-${++counter}@example.com`;

const ORIGINAL_ADMIN = process.env.IS_ADMIN_EMAIL;

async function makeFamily(emailOverride?: string) {
  const email = emailOverride ?? uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'invpw1234567890' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
  };
}

beforeEach(() => {
  delete process.env.IS_ADMIN_EMAIL;
});

afterAll(() => {
  if (ORIGINAL_ADMIN === undefined) {
    delete process.env.IS_ADMIN_EMAIL;
  } else {
    process.env.IS_ADMIN_EMAIL = ORIGINAL_ADMIN;
  }
});

describe('POST /api/v1/admin/invite-codes', () => {
  it('mints a new code (default single-use, no expiry) when caller is on the admin allowlist', async () => {
    const adminEmail = uniqueEmail();
    process.env.IS_ADMIN_EMAIL = adminEmail;
    const f = await makeFamily(adminEmail);

    const r = await request(app)
      .post('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^[a-f0-9]{16}$/);
    expect(r.body.max_uses).toBe(1);
    expect(r.body.expires_at).toBeNull();
  });

  it('honours max_uses + expires_in_days', async () => {
    const adminEmail = uniqueEmail();
    process.env.IS_ADMIN_EMAIL = adminEmail;
    const f = await makeFamily(adminEmail);

    const r = await request(app)
      .post('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ max_uses: 5, expires_in_days: 14 });
    expect(r.status).toBe(201);
    expect(r.body.max_uses).toBe(5);
    expect(r.body.expires_at).toBeTruthy();

    // Sanity: expires_at is in the future, roughly 14 days out.
    const ms = new Date(r.body.expires_at).getTime() - Date.now();
    const days = ms / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(13.5);
    expect(days).toBeLessThan(14.5);
  });

  it('refuses non-admin parents (403)', async () => {
    process.env.IS_ADMIN_EMAIL = 'someone-else@example.com';
    const f = await makeFamily();
    const r = await request(app)
      .post('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(403);
  });

  it('refuses everyone when IS_ADMIN_EMAIL is empty/unset (403 admin disabled)', async () => {
    delete process.env.IS_ADMIN_EMAIL;
    const f = await makeFamily();
    const r = await request(app)
      .post('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'admin disabled' });
  });

  it('accepts a comma-separated allowlist', async () => {
    const adminEmail = uniqueEmail();
    process.env.IS_ADMIN_EMAIL = `someone@example.com, ${adminEmail}, other@example.com`;
    const f = await makeFamily(adminEmail);

    const r = await request(app)
      .post('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(201);
  });

  it('requires auth', async () => {
    process.env.IS_ADMIN_EMAIL = uniqueEmail();
    const r = await request(app).post('/api/v1/admin/invite-codes').send({});
    expect(r.status).toBe(401);
  });
});

describe('GET /api/v1/admin/invite-codes', () => {
  it('lists every code with derived status', async () => {
    const adminEmail = uniqueEmail();
    process.env.IS_ADMIN_EMAIL = adminEmail;
    const f = await makeFamily(adminEmail);

    // Seed three codes — active, used, expired.
    const tag = `${Date.now()}-${counter}`;
    await db.query(
      `INSERT INTO invite_codes (code, max_uses, uses_count, expires_at)
       VALUES ($1, 1, 0, NULL),
              ($2, 1, 1, NULL),
              ($3, 1, 0, NOW() - INTERVAL '1 hour')`,
      [`active-${tag}`, `used-${tag}`, `expired-${tag}`],
    );

    const r = await request(app)
      .get('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`);
    expect(r.status).toBe(200);
    const byCode = Object.fromEntries(
      r.body.codes.map((c: { code: string; status: string }) => [c.code, c.status]),
    );
    expect(byCode[`active-${tag}`]).toBe('active');
    expect(byCode[`used-${tag}`]).toBe('used');
    expect(byCode[`expired-${tag}`]).toBe('expired');
  });

  it('refuses non-admin', async () => {
    process.env.IS_ADMIN_EMAIL = 'someone-else@example.com';
    const f = await makeFamily();
    const r = await request(app)
      .get('/api/v1/admin/invite-codes')
      .set('Authorization', `Bearer ${f.token}`);
    expect(r.status).toBe(403);
  });
});
