import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';

let counter = 0;
const uniqueEmail = () => `gate-${Date.now()}-${++counter}@example.com`;

const ORIGINAL_ENABLED = process.env.SIGNUP_ENABLED;

function setEnabled(enabled: boolean): void {
  if (enabled) {
    delete process.env.SIGNUP_ENABLED;
  } else {
    process.env.SIGNUP_ENABLED = 'false';
  }
}

async function seedInviteCode(opts: {
  code: string;
  max_uses?: number;
  expires_at?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO invite_codes (code, max_uses, expires_at)
     VALUES ($1, $2, $3::timestamptz)
     ON CONFLICT (code) DO UPDATE SET
       max_uses = EXCLUDED.max_uses,
       expires_at = EXCLUDED.expires_at,
       uses_count = 0,
       used_at = NULL,
       used_by_parent_id = NULL`,
    [opts.code, opts.max_uses ?? 1, opts.expires_at ?? null],
  );
}

beforeEach(() => {
  setEnabled(true);
});

afterAll(() => {
  if (ORIGINAL_ENABLED === undefined) {
    delete process.env.SIGNUP_ENABLED;
  } else {
    process.env.SIGNUP_ENABLED = ORIGINAL_ENABLED;
  }
});

describe('signup gate — SIGNUP_ENABLED open mode', () => {
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

describe('signup gate — SIGNUP_ENABLED=false', () => {
  beforeEach(() => setEnabled(false));

  it('rejects with no invite_code (signup_closed)', async () => {
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456' });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'signup_closed' });
  });

  it('rejects an invite_code that doesn\'t exist in invite_codes', async () => {
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({
        email: uniqueEmail(),
        password: 'gatepw123456',
        invite_code: 'this-code-was-never-minted',
      });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: 'signup_closed' });
  });

  it('accepts an active invite_codes row + increments uses_count', async () => {
    const code = `signup-test-${Date.now()}-${counter}`;
    await seedInviteCode({ code, max_uses: 1 });
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(r.status).toBe(201);

    const row = await db.query(
      'SELECT uses_count, used_at, used_by_parent_id FROM invite_codes WHERE code = $1',
      [code],
    );
    expect(row.rows[0].uses_count).toBe(1);
    expect(row.rows[0].used_at).toBeTruthy();
    expect(row.rows[0].used_by_parent_id).toBe(r.body.parent.id);
  });

  it('rejects a used-up single-use code on the second consumer', async () => {
    const code = `single-use-${Date.now()}-${counter}`;
    await seedInviteCode({ code, max_uses: 1 });

    const first = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(second.status).toBe(403);
  });

  it('multi-use codes admit multiple signups until uses_count == max_uses', async () => {
    const code = `multi-use-${Date.now()}-${counter}`;
    await seedInviteCode({ code, max_uses: 2 });

    const a = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(a.status).toBe(201);

    const b = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(b.status).toBe(201);

    const c = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(c.status).toBe(403);

    const row = await db.query(
      'SELECT uses_count, used_by_parent_id FROM invite_codes WHERE code = $1',
      [code],
    );
    expect(row.rows[0].uses_count).toBe(2);
    // used_by_parent_id is set on FIRST consumption only, not last.
    expect(row.rows[0].used_by_parent_id).toBe(a.body.parent.id);
  });

  it('rejects an expired invite code', async () => {
    const code = `expired-code-${Date.now()}-${counter}`;
    await db.query(
      `INSERT INTO invite_codes (code, max_uses, expires_at)
       VALUES ($1, 1, NOW() - INTERVAL '1 day')`,
      [code],
    );
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456', invite_code: code });
    expect(r.status).toBe(403);
  });
});

describe('signup gate — env parsing edge cases', () => {
  it('SIGNUP_ENABLED="0" disables signup', async () => {
    process.env.SIGNUP_ENABLED = '0';
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456' });
    expect(r.status).toBe(403);
  });

  it('SIGNUP_ENABLED="False" (mixed case) does NOT disable — strict match only', async () => {
    process.env.SIGNUP_ENABLED = 'False';
    const r = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'gatepw123456' });
    expect(r.status).toBe(201);
  });

  it('unknown body fields still rejected (.strict() on schema)', async () => {
    delete process.env.SIGNUP_ENABLED;
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
