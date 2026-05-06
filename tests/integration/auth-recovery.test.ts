import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';

let counter = 0;
const uniqueEmail = () => `recover-${Date.now()}-${++counter}@example.com`;

async function signup(email: string, password = 'recoverypw1234') {
  return request(app).post('/api/v1/auth/signup').send({ email, password });
}

describe('email verification', () => {
  it('signup sets a verification token; verify-email clears it and stamps verified_at', async () => {
    const email = uniqueEmail();
    const sig = await signup(email);
    expect(sig.status).toBe(201);

    const tokenRow = await db.query(
      'SELECT email_verification_token, email_verified_at FROM parents WHERE email = $1',
      [email],
    );
    expect(tokenRow.rows[0].email_verified_at).toBeNull();
    const token = tokenRow.rows[0].email_verification_token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);

    const verify = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token });
    expect(verify.status).toBe(200);

    const after = await db.query(
      'SELECT email_verification_token, email_verified_at FROM parents WHERE email = $1',
      [email],
    );
    expect(after.rows[0].email_verification_token).toBeNull();
    expect(after.rows[0].email_verified_at).not.toBeNull();
  });

  it('rejects unknown verification token', async () => {
    const r = await request(app)
      .post('/api/v1/auth/verify-email')
      .send({ token: 'unknown_token_with_enough_length_to_pass' });
    expect(r.status).toBe(400);
  });
});

describe('forgot + reset password', () => {
  it('forgot-password issues a reset token; reset-password rotates the password', async () => {
    const email = uniqueEmail();
    const sig = await signup(email, 'oldpassword12345');
    const oldToken = sig.body.token;

    const forgot = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email });
    expect(forgot.status).toBe(200);

    const tokenRow = await db.query(
      'SELECT password_reset_token FROM parents WHERE email = $1',
      [email],
    );
    const resetToken = tokenRow.rows[0].password_reset_token;
    expect(typeof resetToken).toBe('string');

    const reset = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: resetToken, password: 'newpassword12345' });
    expect(reset.status).toBe(200);

    // Old password no longer works.
    const badLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'oldpassword12345' });
    expect(badLogin.status).toBe(401);

    // New one works.
    const goodLogin = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'newpassword12345' });
    expect(goodLogin.status).toBe(200);

    // Old JWT (issued before reset) now revoked.
    const me = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(me.status).toBe(401);
  });

  it('forgot-password is no-op for unknown email but still returns 200 (no enumeration)', async () => {
    const r = await request(app)
      .post('/api/v1/auth/forgot-password')
      .send({ email: 'nobody-here-x@example.com' });
    expect(r.status).toBe(200);
  });

  it('reset-password rejects unknown token', async () => {
    const r = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: 'definitely_not_a_real_token_xx', password: 'whatever12345' });
    expect(r.status).toBe(400);
  });
});

describe('change password (authenticated)', () => {
  it('rotates the password and revokes other sessions', async () => {
    const email = uniqueEmail();
    const sig = await signup(email, 'startingpw12345');
    const tokenA = sig.body.token;

    // Get a SECOND independent token via login to simulate a second device.
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'startingpw12345' });
    const tokenB = login.body.token;

    const change = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ current_password: 'startingpw12345', new_password: 'rotatedpw12345' });
    expect(change.status).toBe(200);

    // Both old tokens should be revoked (revokeAllForParent uses iat floor).
    const meA = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenA}`);
    const meB = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(meA.status).toBe(401);
    expect(meB.status).toBe(401);
  });

  it('rejects wrong current password', async () => {
    const email = uniqueEmail();
    const sig = await signup(email, 'startingpw12345');
    const r = await request(app)
      .post('/api/v1/auth/change-password')
      .set('Authorization', `Bearer ${sig.body.token}`)
      .send({ current_password: 'wrong-original', new_password: 'newpw12345678' });
    expect(r.status).toBe(401);
  });
});

describe('logout (single-session revocation)', () => {
  it('revokes only the calling token', async () => {
    const email = uniqueEmail();
    const sig = await signup(email, 'logoutpw12345');
    const tokenA = sig.body.token;

    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'logoutpw12345' });
    const tokenB = login.body.token;

    const logout = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${tokenA}`);
    expect(logout.status).toBe(200);

    const meA = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenA}`);
    const meB = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(meA.status).toBe(401);
    expect(meB.status).toBe(200);
  });
});
