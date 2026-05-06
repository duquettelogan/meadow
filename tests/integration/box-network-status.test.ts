import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `bns-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniquePairingCodeForTest = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function makeVerifiedParent() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'bnspw12345' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

async function pairBoxFor(token: string): Promise<{
  api_key: string;
  device_id: string;
}> {
  const hardware_id = uniqueHwId();
  const code = uniquePairingCodeForTest();

  await request(app)
    .post('/api/v1/pairing/register')
    .send({ hardware_id, pairing_code: code, platform: 'router' });

  const claim = await request(app)
    .post('/api/v1/pairing/claim-by-code')
    .set('Authorization', `Bearer ${token}`)
    .send({ pairing_code: code });
  expect(claim.status).toBe(200);

  const status = await request(app).get(
    `/api/v1/pairing/box-status/${hardware_id}`,
  );
  return {
    api_key: status.body.api_key,
    device_id: status.body.device_id,
  };
}

describe('POST /api/v1/box/network-status (box pushes)', () => {
  it('writes the payload to devices.network_status', async () => {
    const { token } = await makeVerifiedParent();
    const { api_key, device_id } = await pairBoxFor(token);

    const r = await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${api_key}`)
      .send({
        dhcp_active: true,
        conflict_detected: false,
        servers_seen: [],
        box_ip: '192.168.1.50',
        gateway_ip: '192.168.1.1',
        leases_count: 7,
        last_check_at: '2026-05-06T12:00:00Z',
      });
    expect(r.status).toBe(204);

    const row = await db.query(
      'SELECT network_status FROM devices WHERE id = $1',
      [device_id],
    );
    const ns = row.rows[0].network_status;
    expect(ns.dhcp_active).toBe(true);
    expect(ns.conflict_detected).toBe(false);
    expect(ns.box_ip).toBe('192.168.1.50');
    expect(ns.leases_count).toBe(7);
  });

  it('records a conflict push with audit action box.network.conflict', async () => {
    const { token, family_id } = await makeVerifiedParent();
    const { api_key, device_id } = await pairBoxFor(token);

    await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${api_key}`)
      .send({
        dhcp_active: false,
        conflict_detected: true,
        servers_seen: ['192.168.1.1'],
      });

    await new Promise((r) => setTimeout(r, 200));
    const audit = await db.query(
      `SELECT action FROM audit_log
       WHERE family_id = $1 AND target_id = $2
         AND action = 'box.network.conflict'`,
      [family_id, device_id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });

  it('rejects parent JWT (only box API key is admitted)', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${token}`)
      .send({ dhcp_active: true, conflict_detected: false });
    expect(r.status).toBe(401);
  });

  it('rejects unauthenticated', async () => {
    const r = await request(app)
      .post('/api/v1/box/network-status')
      .send({ dhcp_active: true, conflict_detected: false });
    expect(r.status).toBe(401);
  });

  it('rejects malformed body', async () => {
    const { token } = await makeVerifiedParent();
    const { api_key } = await pairBoxFor(token);
    const r = await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${api_key}`)
      .send({ dhcp_active: 'maybe', conflict_detected: 'sure' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/v1/box/network-status (dashboard reads)', () => {
  it('returns empty defaults for a family with no box', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .get('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      dhcp_active: false,
      conflict_detected: false,
      leases_count: 0,
    });
  });

  it('returns the latest pushed payload for the family', async () => {
    const { token } = await makeVerifiedParent();
    const { api_key } = await pairBoxFor(token);

    await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${api_key}`)
      .send({
        dhcp_active: true,
        conflict_detected: false,
        leases_count: 12,
        box_ip: '192.168.1.50',
        gateway_ip: '192.168.1.1',
      });

    const r = await request(app)
      .get('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body).toMatchObject({
      dhcp_active: true,
      conflict_detected: false,
      leases_count: 12,
      box_ip: '192.168.1.50',
      gateway_ip: '192.168.1.1',
    });
  });

  it('is family-scoped — parent A cannot read parent B\'s box', async () => {
    const a = await makeVerifiedParent();
    const aBox = await pairBoxFor(a.token);
    await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${aBox.api_key}`)
      .send({ dhcp_active: true, conflict_detected: false, leases_count: 5 });

    const b = await makeVerifiedParent();
    const r = await request(app)
      .get('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${b.token}`);
    // Parent B has no box of their own — should see empty defaults,
    // NOT parent A's data.
    expect(r.body.leases_count).toBe(0);
    expect(r.body.dhcp_active).toBe(false);
  });

  it('requires auth', async () => {
    const r = await request(app).get('/api/v1/box/network-status');
    expect(r.status).toBe(401);
  });
});

describe('GET /api/v1/box/health (dashboard roll-up)', () => {
  it('reports paired:false when no box exists', async () => {
    const { token } = await makeVerifiedParent();
    const r = await request(app)
      .get('/api/v1/box/health')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.paired).toBe(false);
    expect(r.body.last_heartbeat).toBeNull();
    expect(r.body.network_status).toBeNull();
  });

  it('rolls up paired + last_heartbeat + network_status + hardware_id', async () => {
    const { token } = await makeVerifiedParent();
    const { api_key } = await pairBoxFor(token);

    await request(app)
      .post('/api/v1/box/network-status')
      .set('Authorization', `Bearer ${api_key}`)
      .send({ dhcp_active: true, conflict_detected: false, leases_count: 4 });

    const r = await request(app)
      .get('/api/v1/box/health')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.paired).toBe(true);
    expect(r.body.last_heartbeat).toBeTruthy();
    expect(r.body.network_status).toMatchObject({
      dhcp_active: true,
      conflict_detected: false,
      leases_count: 4,
    });
    expect(r.body.hardware_id).toBeTruthy();
  });

  it('is family-scoped', async () => {
    const a = await makeVerifiedParent();
    await pairBoxFor(a.token);
    const b = await makeVerifiedParent();
    const r = await request(app)
      .get('/api/v1/box/health')
      .set('Authorization', `Bearer ${b.token}`);
    expect(r.body.paired).toBe(false);
  });
});
