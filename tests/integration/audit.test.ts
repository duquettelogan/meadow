import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';

let counter = 0;
const uniqueEmail = () => `audit-${Date.now()}-${++counter}@example.com`;

async function recentAuditCount(action: string, sinceIso: string): Promise<number> {
  // Audit writes are fire-and-forget in route handlers (don't block the
  // response). Wait long enough for them to flush. 200ms is generous;
  // bump if this turns out to flake on slow CI runners.
  await new Promise((r) => setTimeout(r, 200));
  const r = await db.query(
    'SELECT COUNT(*)::int AS c FROM audit_log WHERE action = $1 AND occurred_at >= $2',
    [action, sinceIso],
  );
  return r.rows[0].c;
}

describe('audit log', () => {
  it('signup writes parent.signup', async () => {
    const since = new Date().toISOString();
    const email = uniqueEmail();
    await request(app).post('/api/v1/auth/signup').send({ email, password: 'auditpw12345' });
    expect(await recentAuditCount('parent.signup', since)).toBeGreaterThanOrEqual(1);
  });

  it('failed login writes parent.login.failed', async () => {
    const since = new Date().toISOString();
    await request(app).post('/api/v1/auth/login').send({
      email: 'nobody-audit@example.com',
      password: 'wrongpassword',
    });
    expect(await recentAuditCount('parent.login.failed', since)).toBeGreaterThanOrEqual(1);
  });

  it('child create + policy update both audited', async () => {
    const sig = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'auditpw12345' });
    const token = sig.body.token;

    const since = new Date().toISOString();

    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'AuditKid' });
    expect(child.status).toBe(201);

    await request(app)
      .patch(`/api/v1/children/${child.body.id}/policy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ blocked_categories: ['gambling'] });

    expect(await recentAuditCount('child.created', since)).toBeGreaterThanOrEqual(1);
    expect(await recentAuditCount('child.policy.updated', since)).toBeGreaterThanOrEqual(1);
  });

  it('audit row contains expected fields', async () => {
    const sig = await request(app)
      .post('/api/v1/auth/signup')
      .send({ email: uniqueEmail(), password: 'auditpw12345' });

    await new Promise((r) => setTimeout(r, 200));
    const row = await db.query(
      `SELECT family_id, parent_id, action, ip
       FROM audit_log
       WHERE parent_id = (SELECT id FROM parents WHERE family_id = $1)
       ORDER BY occurred_at DESC
       LIMIT 1`,
      [sig.body.parent.family_id],
    );
    expect(row.rows[0].action).toBe('parent.signup');
    expect(row.rows[0].family_id).toBe(sig.body.parent.family_id);
    expect(row.rows[0].parent_id).toBeTruthy();
  });
});
