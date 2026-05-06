import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `hb-${Date.now()}-${++counter}@example.com`;

async function makeFamilyChildDeviceWithKey() {
  const email = uniqueEmail();
  const signup = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'heartbeatpw1234' });
  const token = signup.body.token;
  // Bypass the email-verification gate so the fixture can call POST /children.
  await verifyEmailFor(email);

  const child = await request(app)
    .post('/api/v1/children')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'HBKid' });

  const device = await request(app)
    .post('/api/v1/devices/register')
    .set('Authorization', `Bearer ${token}`)
    .send({
      child_profile_id: child.body.id,
      platform: 'router',
      device_token: `dt-hb-${Date.now()}-${counter}`,
    });

  const keyResp = await request(app)
    .post(`/api/v1/auth/devices/${device.body.id}/keys`)
    .set('Authorization', `Bearer ${token}`);

  return { token, deviceId: device.body.id, apiKey: keyResp.body.key };
}

describe('heartbeat endpoint', () => {
  it('valid heartbeat returns 204 and updates last_seen + last_health_payload', async () => {
    const { deviceId, apiKey } = await makeFamilyChildDeviceWithKey();

    const res = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({
        ts: Math.floor(Date.now() / 1000),
        uptime_seconds: 3600,
        free_memory_mb: 512,
        blocklist_versions: { adult: 158000, malware: 810 },
        box_version: '1.0.0',
      });
    expect(res.status).toBe(204);

    const row = await db.query(
      'SELECT last_seen, last_health_payload FROM devices WHERE id = $1',
      [deviceId],
    );
    expect(row.rows[0].last_seen).toBeTruthy();
    const payload = row.rows[0].last_health_payload;
    expect(payload.uptime_seconds).toBe(3600);
    expect(payload.box_version).toBe('1.0.0');
    expect(payload.blocklist_versions.adult).toBe(158000);
  });

  it('rejects heartbeat without device key', async () => {
    const res = await request(app)
      .post('/api/v1/devices/heartbeat')
      .send({ uptime_seconds: 1 });
    expect(res.status).toBe(401);
  });

  it('rejects heartbeat with garbage api key', async () => {
    const res = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', 'Bearer mk_deadbeef')
      .send({ uptime_seconds: 1 });
    expect(res.status).toBe(401);
  });

  it('accepts an empty body', async () => {
    const { apiKey } = await makeFamilyChildDeviceWithKey();
    const res = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({});
    expect(res.status).toBe(204);
  });

  it('rejects unknown fields in heartbeat body', async () => {
    const { apiKey } = await makeFamilyChildDeviceWithKey();
    const res = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ uptime_seconds: 1, what_is_this: 'oops' });
    expect(res.status).toBe(400);
  });
});
