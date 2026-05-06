import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

/**
 * End-to-end API tests. Hits the real Express app with supertest, against
 * the real Postgres test database. Each test uses a unique email so they
 * don't collide.
 */

let counter = 0;
const uniqueEmail = () => `test-${Date.now()}-${++counter}@example.com`;

beforeAll(async () => {
  // Make sure the schema is in place. Tests assume migrations have been run
  // against the test DB; if not, this errors immediately with a clear message.
  const r = await db.query(
    `SELECT EXISTS (
       SELECT FROM information_schema.tables
       WHERE table_name = 'parents'
     ) AS exists;`
  );
  if (!r.rows[0]?.exists) {
    throw new Error(
      'Test database schema not initialized. Run: npx ts-node src/db/migrate.ts && npx ts-node src/db/migrate-003.ts against the test DB first.'
    );
  }
});

afterAll(async () => {
  // Connection pool is closed in tests/setup.ts afterAll.
});

describe('auth flow', () => {
  it('signup → login → /me round-trip', async () => {
    const email = uniqueEmail();
    const password = 'integrationtestpw';

    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password });
    expect(signup.status).toBe(201);
    expect(signup.body.token).toBeTruthy();
    expect(signup.body.parent.email).toBe(email);

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(email);
  });

  it('rejects duplicate signup', async () => {
    const email = uniqueEmail();
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'somepassword12' });
    const dup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'somepassword12' });
    expect(dup.status).toBe(409);
  });

  it('rejects invalid email', async () => {
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: 'invalid', password: 'longenoughpw' });
    expect(r.status).toBe(400);
  });

  it('rejects short password', async () => {
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'short' });
    expect(r.status).toBe(400);
  });

  it('rejects login with wrong password', async () => {
    const email = uniqueEmail();
    await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'rightpassword12' });
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrongpassword' });
    expect(r.status).toBe(401);
  });

  it('rejects login with unknown email', async () => {
    const r = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'doesnotexist@example.com', password: 'anything12345' });
    expect(r.status).toBe(401);
  });
});

describe('auth gates', () => {
  it('children endpoint requires auth', async () => {
    const r = await request(app).post('/api/v1/children').send({ name: 'Kid' });
    expect(r.status).toBe(401);
  });

  it('children endpoint rejects malformed token', async () => {
    const r = await request(app)
      .post('/api/v1/children')
      .set('Authorization', 'Bearer notarealtoken')
      .send({ name: 'Kid' });
    expect(r.status).toBe(401);
  });

  it('parent cannot access another family', async () => {
    // Create two parents in two families.
    const emailA = uniqueEmail();
    const emailB = uniqueEmail();
    const a = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: emailA, password: 'parentapw1234' });
    const b = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: emailB, password: 'parentbpw1234' });
    await verifyEmailFor(emailA);
    await verifyEmailFor(emailB);

    // Parent A creates a child.
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.body.token}`)
      .send({ name: 'AKid' });
    expect(child.status).toBe(201);

    // Parent B tries to read it.
    const cross = await request(app)
      .get(`/api/v1/children/${child.body.id}`)
      .set('Authorization', `Bearer ${b.body.token}`);
    expect(cross.status).toBe(403);
  });
});

describe('children + policy', () => {
  it('creates a child and updates its policy', async () => {
    const email = uniqueEmail();
    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'parentpw12345' });
    await verifyEmailFor(email);
    const token = signup.body.token;

    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma', tier: 'strict' });
    expect(child.status).toBe(201);
    expect(child.body.tier).toBe('strict');

    const update = await request(app)
      .patch(`/api/v1/children/${child.body.id}/policy`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        blocked_categories: ['gambling'],
        safe_search_enforce: true,
      });
    expect(update.status).toBe(200);

    const get = await request(app)
      .get(`/api/v1/children/${child.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(get.status).toBe(200);
    expect(get.body.blocked_categories).toContain('gambling');
  });

  it('rejects invalid tier', async () => {
    const email = uniqueEmail();
    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'parentpw12345' });
    await verifyEmailFor(email);
    const token = signup.body.token;

    const r = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma', tier: 'paranoid' });
    expect(r.status).toBe(400);
  });
});

describe('device api keys', () => {
  it('parent generates a key, key is shown once', async () => {
    const email = uniqueEmail();
    const signup = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email, password: 'parentpw12345' });
    await verifyEmailFor(email);
    const token = signup.body.token;

    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma' });

    const device = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${token}`)
      .send({
        child_profile_id: child.body.id,
        platform: 'ios',
        device_token: `dt-${Date.now()}-${counter}`,
      });
    expect(device.status).toBe(201);

    const keyResp = await request(app)
      .post(`/api/v1/auth/devices/${device.body.id}/keys`)
      .set('Authorization', `Bearer ${token}`);
    expect(keyResp.status).toBe(201);
    expect(keyResp.body.key).toMatch(/^mk_[a-f0-9]+$/);
    expect(keyResp.body.warning).toContain('not be shown again');
  });

  it('refuses to generate keys for another family\'s device', async () => {
    const emailA = uniqueEmail();
    const emailB = uniqueEmail();
    const a = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: emailA, password: 'parentapw1234' });
    const b = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: emailB, password: 'parentbpw1234' });
    await verifyEmailFor(emailA);
    await verifyEmailFor(emailB);

    const childA = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${a.body.token}`)
      .send({ name: 'AKid' });

    const deviceA = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${a.body.token}`)
      .send({
        child_profile_id: childA.body.id,
        platform: 'ios',
        device_token: `dt-cross-${Date.now()}-${counter}`,
      });

    const cross = await request(app)
      .post(`/api/v1/auth/devices/${deviceA.body.id}/keys`)
      .set('Authorization', `Bearer ${b.body.token}`);
    expect(cross.status).toBe(403);
  });
});

describe('public endpoints', () => {
  it('/health returns ok', async () => {
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('unknown route returns 404', async () => {
    const r = await request(app).get('/api/v1/does-not-exist');
    expect(r.status).toBe(404);
  });
});
