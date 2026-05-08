import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `acct-${Date.now()}-${++counter}@example.com`;

async function makeFamily() {
  const email = uniqueEmail();
  const password = 'acctpw1234567';
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    password,
    token: sig.body.token as string,
    parent_id: sig.body.parent.id as string,
    family_id: sig.body.parent.family_id as string,
  };
}

describe('PATCH /api/v1/account', () => {
  it('updates family_name on its own', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ family_name: 'The Duquette Family' });
    expect(r.status).toBe(200);
    expect(r.body.family_name).toBe('The Duquette Family');
    expect(r.body.email).toBe(f.email); // email untouched
    expect(r.body.email_verified_at).not.toBeNull(); // verification untouched

    const row = await db.query(
      'SELECT name FROM families WHERE id = $1',
      [f.family_id],
    );
    expect(row.rows[0].name).toBe('The Duquette Family');
  });

  it('updates email and clears email_verified_at', async () => {
    const f = await makeFamily();
    const newEmail = uniqueEmail();

    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: newEmail });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(newEmail);
    expect(r.body.email_verified_at).toBeNull();

    const row = await db.query(
      `SELECT email, email_verified_at, email_verification_token,
              email_verification_expires_at
       FROM parents WHERE id = $1`,
      [f.parent_id],
    );
    expect(row.rows[0].email).toBe(newEmail);
    expect(row.rows[0].email_verified_at).toBeNull();
    expect(row.rows[0].email_verification_token).toBeTruthy();
    expect(row.rows[0].email_verification_expires_at).toBeTruthy();
  });

  it('email change resyncs families.email when caller is the founding parent', async () => {
    const f = await makeFamily();
    const newEmail = uniqueEmail();

    await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: newEmail });

    const fam = await db.query(
      'SELECT email FROM families WHERE id = $1',
      [f.family_id],
    );
    expect(fam.rows[0].email).toBe(newEmail);
  });

  it('rejects empty body', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('rejects unknown body fields', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ family_name: 'X', surprise_admin: true });
    expect(r.status).toBe(400);
  });

  it('rejects email already used by another parent (409)', async () => {
    const a = await makeFamily();
    const b = await makeFamily();

    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${a.token}`)
      .send({ email: b.email });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'email already registered' });
  });

  it('rejects malformed email', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .patch('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ email: 'not-an-email' });
    expect(r.status).toBe(400);
  });

  it('requires auth', async () => {
    const r = await request(app)
      .patch('/api/v1/account')
      .send({ family_name: 'X' });
    expect(r.status).toBe(401);
  });
});

describe('DELETE /api/v1/account', () => {
  it('hard-deletes the family on correct password (204)', async () => {
    const f = await makeFamily();

    // Seed a child + filter policy + device + counter to confirm cascade.
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Emma' });
    expect(child.status).toBe(201);

    await db.query(
      `INSERT INTO block_counters (child_profile_id, day, category, count)
       VALUES ($1, CURRENT_DATE, 'malware', 3)`,
      [child.body.id],
    );

    const device = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        child_profile_id: child.body.id,
        platform: 'ios',
        device_token: `dt-acctdel-${Date.now()}-${counter}`,
      });

    const r = await request(app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ password_confirmation: f.password });
    expect(r.status).toBe(204);

    // Family + every dependent table swept.
    const fam = await db.query('SELECT 1 FROM families WHERE id = $1', [
      f.family_id,
    ]);
    expect(fam.rows.length).toBe(0);

    const parents = await db.query('SELECT 1 FROM parents WHERE id = $1', [
      f.parent_id,
    ]);
    expect(parents.rows.length).toBe(0);

    const children = await db.query(
      'SELECT 1 FROM child_profiles WHERE id = $1',
      [child.body.id],
    );
    expect(children.rows.length).toBe(0);

    const devices = await db.query('SELECT 1 FROM devices WHERE id = $1', [
      device.body.id,
    ]);
    expect(devices.rows.length).toBe(0);

    const counters = await db.query(
      'SELECT 1 FROM block_counters WHERE child_profile_id = $1',
      [child.body.id],
    );
    expect(counters.rows.length).toBe(0);

    // Audit row preserved (denormalized, no FK). Two parameters here
    // even though both bind to the same value: target_id is TEXT
    // (polymorphic), family_id is UUID. Sharing $1 makes pg infer
    // the parameter as UUID from the first clause and Postgres then
    // can't apply `text = uuid` for the second — so we send the
    // value twice with $2 cast to text-friendly territory.
    const auditRow = await db.query(
      `SELECT 1 FROM audit_log
       WHERE family_id = $1 AND target_id = $2 AND action = 'family.deleted'`,
      [f.family_id, f.family_id],
    );
    expect(auditRow.rows.length).toBe(1);
  });

  it('rejects wrong password (401)', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ password_confirmation: 'definitely-wrong' });
    expect(r.status).toBe(401);

    // Family still here.
    const fam = await db.query('SELECT 1 FROM families WHERE id = $1', [
      f.family_id,
    ]);
    expect(fam.rows.length).toBe(1);
  });

  it('rejects missing body field', async () => {
    const f = await makeFamily();
    const r = await request(app)
      .delete('/api/v1/account')
      .set('Authorization', `Bearer ${f.token}`)
      .send({});
    expect(r.status).toBe(400);
  });

  it('requires auth', async () => {
    const r = await request(app)
      .delete('/api/v1/account')
      .send({ password_confirmation: 'whatever' });
    expect(r.status).toBe(401);
  });
});
