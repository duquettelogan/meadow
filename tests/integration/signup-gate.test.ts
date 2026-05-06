import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';

let counter = 0;
const uniqueEmail = () => `gate-${Date.now()}-${++counter}@example.com`;

const ORIGINAL_ENABLED = process.env.SIGNUP_ENABLED;
const ORIGINAL_CODE = process.env.SIGNUP_INVITE_CODE;

function setSignupEnv(enabled: boolean, code: string | null): void {
  // The auth-routes module reads these at request time, not load time,
  // so flipping env between tests is sufficient — no module reset needed.
  if (enabled) {
    delete process.env.SIGNUP_ENABLED; // unset = default true
  } else {
    process.env.SIGNUP_ENABLED = 'false';
  }
  if (code === null) {
    delete process.env.SIGNUP_INVITE_CODE;
  } else {
    process.env.SIGNUP_INVITE_CODE = code;
  }
}

beforeEach(() => {
  // Each test sets its own env; reset between tests so failures
  // don't bleed.
  setSignupEnv(true, null);
});

afterAll(() => {
  // Restore whatever the surrounding process had.
  if (ORIGINAL_ENABLED === undefined) {
    delete process.env.SIGNUP_ENABLED;
  } else {
    process.env.SIGNUP_ENABLED = ORIGINAL_ENABLED;
  }
  if (ORIGINAL_CODE === undefined) {
    delete process.env.SIGNUP_INVITE_CODE;
  } else {
    process.env.SIGNUP_INVITE_CODE = ORIGINAL_CODE;
  }
});

describe('signup gate — env truth table', () => {
  // The user asked for "all four combinations" of (SIGNUP_ENABLED,
  // SIGNUP_INVITE_CODE empty/set). Each block below is one cell of
  // that 2x2; for the bottom-right cell (closed + code set) the
  // invite-code subcases (missing / wrong / right) are also covered.

  describe('SIGNUP_ENABLED=true, SIGNUP_INVITE_CODE empty', () => {
    beforeEach(() => setSignupEnv(true, null));

    it('signup succeeds without invite_code', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(201);
      expect(r.body.token).toBeTruthy();
    });

    it('signup succeeds even if invite_code is supplied (it is ignored)', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: 'whatever-this-is-ignored',
        });
      expect(r.status).toBe(201);
    });
  });

  describe('SIGNUP_ENABLED=true, SIGNUP_INVITE_CODE set', () => {
    beforeEach(() => setSignupEnv(true, 'super-secret-code'));

    it('signup succeeds without invite_code (env code is ignored when open)', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(201);
    });

    it('signup succeeds with WRONG invite_code (still ignored when open)', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: 'totally-wrong',
        });
      expect(r.status).toBe(201);
    });
  });

  describe('SIGNUP_ENABLED=false, SIGNUP_INVITE_CODE empty', () => {
    beforeEach(() => setSignupEnv(false, null));

    it('signup is fully closed — no invite_code', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'signup_closed' });
    });

    it('signup is fully closed — even WITH invite_code in body', async () => {
      // No env-side code to compare against, so any client-supplied
      // value can never match. Locked.
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: 'any-code-at-all',
        });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'signup_closed' });
    });

    it('also closed when env code is whitespace-only', async () => {
      setSignupEnv(false, '   ');
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: '   ',
        });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'signup_closed' });
    });
  });

  describe('SIGNUP_ENABLED=false, SIGNUP_INVITE_CODE set', () => {
    const CODE = 'beta-2026-meadow-x7q9';
    beforeEach(() => setSignupEnv(false, CODE));

    it('rejects when invite_code is missing', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'signup_closed' });
    });

    it('rejects when invite_code is wrong', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: 'not-the-right-code',
        });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: 'signup_closed' });
    });

    it('rejects on prefix match (constant-time compare)', async () => {
      // safeEqual short-circuits on length mismatch but otherwise
      // does a timing-safe byte compare — a prefix should not match.
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: CODE.slice(0, -1), // one char short
        });
      expect(r.status).toBe(403);
    });

    it('accepts when invite_code matches exactly', async () => {
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          invite_code: CODE,
        });
      expect(r.status).toBe(201);
      expect(r.body.token).toBeTruthy();
    });
  });

  describe('env-var parsing edge cases', () => {
    it('SIGNUP_ENABLED="0" disables signup', async () => {
      process.env.SIGNUP_ENABLED = '0';
      delete process.env.SIGNUP_INVITE_CODE;
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(403);
    });

    it('SIGNUP_ENABLED="False" (mixed case) does NOT disable — strict match only', async () => {
      // Documented contract: only the exact strings "false" and "0"
      // disable. "False"/"FALSE"/"no" are operator typos and we'd
      // rather fail-open than fail-closed accidentally.
      process.env.SIGNUP_ENABLED = 'False';
      delete process.env.SIGNUP_INVITE_CODE;
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({ email: uniqueEmail(), password: 'gatepw123456' });
      expect(r.status).toBe(201);
    });

    it('unknown body fields still rejected (.strict() on schema)', async () => {
      delete process.env.SIGNUP_ENABLED;
      delete process.env.SIGNUP_INVITE_CODE;
      const r = await request(app)
        .post('/api/v1/auth/signup')
        .send({
          email: uniqueEmail(),
          password: 'gatepw123456',
          something_random: 'should be rejected',
        });
      expect(r.status).toBe(400);
    });
  });
});
