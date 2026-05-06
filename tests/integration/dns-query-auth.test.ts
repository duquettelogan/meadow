import { describe, it, expect } from 'vitest';
import request from 'supertest';
import * as dnsPacket from 'dns-packet';
import { app } from '../../src/api/server';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `doh-${Date.now()}-${++counter}@example.com`;

function makeDnsQuery(domain: string): Buffer {
  return Buffer.from(
    dnsPacket.encode({
      type: 'query',
      id: 1,
      flags: dnsPacket.RECURSION_DESIRED,
      questions: [{ type: 'A', name: domain }],
    }),
  );
}

async function makeDeviceKey() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'dohauthpw12345' });
  const token = sig.body.token;
  await verifyEmailFor(email);
  const child = await request(app)
    .post('/api/v1/children')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'DKid' });
  const device = await request(app)
    .post('/api/v1/devices/register')
    .set('Authorization', `Bearer ${token}`)
    .send({
      child_profile_id: child.body.id,
      platform: 'router',
      device_token: `dt-doh-${Date.now()}-${counter}`,
    });
  const keyResp = await request(app)
    .post(`/api/v1/auth/devices/${device.body.id}/keys`)
    .set('Authorization', `Bearer ${token}`);
  return keyResp.body.key;
}

describe('DoH /dns-query authentication (Phase 4.1)', () => {
  it('rejects POST without device key', async () => {
    const r = await request(app)
      .post('/dns-query')
      .set('Content-Type', 'application/dns-message')
      .send(makeDnsQuery('example.com'));
    expect(r.status).toBe(401);
  });

  it('rejects GET without device key', async () => {
    const r = await request(app).get('/dns-query?dns=AAABAAABAAAAAAAABmdvb2dsZQNjb20AAAEAAQ');
    expect(r.status).toBe(401);
  });

  it('accepts POST with a valid device key', async () => {
    const apiKey = await makeDeviceKey();
    const r = await request(app)
      .post('/dns-query')
      .set('Content-Type', 'application/dns-message')
      .set('Authorization', `Bearer ${apiKey}`)
      .send(makeDnsQuery('988lifeline.org'));
    // 988lifeline is on the crisis floor — handler tries upstream, which
    // likely succeeds (test env) or 500s if no DNS. We accept either —
    // the contract under test is "auth gate works", not upstream behavior.
    expect([200, 500]).toContain(r.status);
  });
});
