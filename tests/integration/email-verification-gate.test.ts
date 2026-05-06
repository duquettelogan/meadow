import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `verifgate-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniquePairingCodeForTest = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function signup(email: string) {
  return request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'verifgatepw12345' });
}

describe('email-verification gate', () => {
  describe('POST /api/v1/children — NOT gated (just metadata)', () => {
    it('lets an unverified parent create a child profile (201)', async () => {
      const sig = await signup(uniqueEmail());
      expect(sig.status).toBe(201);

      const r = await request(app)
        .post('/api/v1/children')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ name: 'UngatedKid' });

      // Hot patch fix/unblock-children-without-email-verify: adding
      // a kid's name is just metadata. The gate stays on
      // /pairing/claim* (the truly sensitive action — binding a
      // physical box to the family).
      expect(r.status).toBe(201);
      expect(r.body.name).toBe('UngatedKid');
    });

    it('still works for a verified parent (regression check)', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);
      await verifyEmailFor(email);

      const r = await request(app)
        .post('/api/v1/children')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ name: 'OkayKid' });

      expect(r.status).toBe(201);
    });

    it('still requires auth', async () => {
      const r = await request(app)
        .post('/api/v1/children')
        .send({ name: 'NoAuthKid' });
      expect(r.status).toBe(401);
    });
  });

  describe('POST /api/v1/pairing/claim — STILL gated', () => {
    it('returns 403 email_not_verified for unverified parent', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);

      const child = await request(app)
        .post('/api/v1/children')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ name: 'PairKid' });
      // /children no longer gated — this works without verification.
      expect(child.status).toBe(201);

      const start = await request(app)
        .post('/api/v1/pairing/start')
        .send({ hardware_id: uniqueHwId(), platform: 'router' });
      expect(start.status).toBe(201);

      // Parent is still unverified — claim must reject.
      const claim = await request(app)
        .post('/api/v1/pairing/claim')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ code: start.body.code, child_profile_id: child.body.id });

      expect(claim.status).toBe(403);
      expect(claim.body).toEqual({ error: 'email_not_verified' });
    });

    it('returns 200 for verified parent claiming a paired device', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);
      await verifyEmailFor(email);

      const child = await request(app)
        .post('/api/v1/children')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ name: 'PairKid' });
      expect(child.status).toBe(201);

      const start = await request(app)
        .post('/api/v1/pairing/start')
        .send({ hardware_id: uniqueHwId(), platform: 'router' });

      const claim = await request(app)
        .post('/api/v1/pairing/claim')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ code: start.body.code, child_profile_id: child.body.id });

      expect(claim.status).toBe(200);
    });
  });

  describe('POST /api/v1/pairing/claim-by-code — STILL gated', () => {
    it('returns 403 email_not_verified for unverified parent', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);

      // Box pre-registers a code (anonymous, doesn't go through the gate).
      const code = uniquePairingCodeForTest();
      await request(app)
        .post('/api/v1/pairing/register')
        .send({ hardware_id: uniqueHwId(), pairing_code: code });

      const claim = await request(app)
        .post('/api/v1/pairing/claim-by-code')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ pairing_code: code });

      expect(claim.status).toBe(403);
      expect(claim.body).toEqual({ error: 'email_not_verified' });
    });

    it('returns 200 for verified parent claiming a registered code', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);
      await verifyEmailFor(email);

      const code = uniquePairingCodeForTest();
      await request(app)
        .post('/api/v1/pairing/register')
        .send({ hardware_id: uniqueHwId(), pairing_code: code });

      const claim = await request(app)
        .post('/api/v1/pairing/claim-by-code')
        .set('Authorization', `Bearer ${sig.body.token}`)
        .send({ pairing_code: code });

      expect(claim.status).toBe(200);
    });
  });

  describe('open endpoints (gate does NOT apply)', () => {
    it('login works for an unverified parent', async () => {
      const email = uniqueEmail();
      await signup(email);
      const r = await request(app)
        .post('/api/v1/auth/login')
        .send({ email, password: 'verifgatepw12345' });
      expect(r.status).toBe(200);
      expect(r.body.token).toBeTruthy();
    });

    it('/me works for an unverified parent', async () => {
      const sig = await signup(uniqueEmail());
      const me = await request(app)
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${sig.body.token}`);
      expect(me.status).toBe(200);
      expect(me.body.email_verified_at).toBeNull();
    });

    it('/resend-verification works for unverified parent', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);

      const r = await request(app)
        .post('/api/v1/auth/resend-verification')
        .set('Authorization', `Bearer ${sig.body.token}`);
      expect(r.status).toBe(200);
      expect(r.body.success).toBe(true);
      expect(r.body.already_verified).toBeUndefined();

      // A fresh verification token should be on the parent row.
      const row = await db.query(
        'SELECT email_verification_token FROM parents WHERE email = $1',
        [email.toLowerCase()],
      );
      expect(row.rows[0].email_verification_token).toBeTruthy();
    });

    it('/resend-verification is idempotent for already-verified parent', async () => {
      const email = uniqueEmail();
      const sig = await signup(email);
      await verifyEmailFor(email);

      const r = await request(app)
        .post('/api/v1/auth/resend-verification')
        .set('Authorization', `Bearer ${sig.body.token}`);
      expect(r.status).toBe(200);
      expect(r.body.already_verified).toBe(true);
    });

    it('/resend-verification still requires auth', async () => {
      const r = await request(app).post('/api/v1/auth/resend-verification');
      expect(r.status).toBe(401);
    });
  });
});
