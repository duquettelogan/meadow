import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';

let counter = 0;
const uniqueEmail = () => `pair-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () => `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;

async function makeFamilyWithChild() {
  const email = uniqueEmail();
  const signup = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'pairingpw12345' });
  const token = signup.body.token;
  const child = await request(app)
    .post('/api/v1/children')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'PairKid' });
  return { token, childId: child.body.id };
}

describe('pairing flow', () => {
  it('full flow: start → claim → poll returns api key', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const hardware_id = uniqueHwId();

    // Device starts.
    const start = await request(app)
      .post('/api/v1/pairing/start')
      .send({ hardware_id, platform: 'router' });
    expect(start.status).toBe(201);
    expect(start.body.code).toMatch(/^\d{4}-\d{4}$/);

    const code = start.body.code;

    // Device polls — should be pending.
    const poll1 = await request(app)
      .post('/api/v1/pairing/poll')
      .send({ code, hardware_id });
    expect(poll1.status).toBe(202);
    expect(poll1.body.status).toBe('pending');

    // Parent claims.
    const claim = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, child_profile_id: childId });
    expect(claim.status).toBe(200);
    expect(claim.body.device_id).toBeTruthy();

    // Device polls again — should get the key.
    const poll2 = await request(app)
      .post('/api/v1/pairing/poll')
      .send({ code, hardware_id });
    expect(poll2.status).toBe(200);
    expect(poll2.body.status).toBe('ready');
    expect(poll2.body.api_key).toMatch(/^mk_[a-f0-9]+$/);
    expect(poll2.body.device_id).toBe(claim.body.device_id);

    // Subsequent polls — key already retrieved, should fail.
    const poll3 = await request(app)
      .post('/api/v1/pairing/poll')
      .send({ code, hardware_id });
    expect(poll3.status).toBe(410);
  });

  it('rejects polling with wrong hardware_id', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const hardware_id = uniqueHwId();

    const start = await request(app)
      .post('/api/v1/pairing/start')
      .send({ hardware_id, platform: 'router' });
    const code = start.body.code;

    await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, child_profile_id: childId });

    // Different device tries to poll the same code.
    const evil = await request(app)
      .post('/api/v1/pairing/poll')
      .send({ code, hardware_id: uniqueHwId() });
    expect(evil.status).toBe(401);
  });

  it('rejects claim from another family', async () => {
    const a = await makeFamilyWithChild();
    const b = await makeFamilyWithChild();
    const hardware_id = uniqueHwId();

    const start = await request(app)
      .post('/api/v1/pairing/start')
      .send({ hardware_id, platform: 'router' });
    const code = start.body.code;

    // Parent B tries to assign to parent A's child.
    const cross = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${b.token}`)
      .send({ code, child_profile_id: a.childId });
    expect(cross.status).toBe(403);
  });

  it('rejects unknown code', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const r = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: '9999-9999', child_profile_id: childId });
    expect(r.status).toBe(404);
  });

  it('rejects double-claim', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const hardware_id = uniqueHwId();
    const start = await request(app)
      .post('/api/v1/pairing/start')
      .send({ hardware_id, platform: 'router' });
    const code = start.body.code;

    const first = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, child_profile_id: childId });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, child_profile_id: childId });
    expect(second.status).toBe(409);
  });

  it('claim requires auth', async () => {
    const r = await request(app)
      .post('/api/v1/pairing/claim')
      .send({ code: '1234-5678', child_profile_id: '00000000-0000-0000-0000-000000000000' });
    expect(r.status).toBe(401);
  });

  it('rejects invalid code format on claim', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const r = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code: 'abc', child_profile_id: childId });
    expect(r.status).toBe(400);
  });

  it('paired device api key works for /resolve', async () => {
    const { token, childId } = await makeFamilyWithChild();
    const hardware_id = uniqueHwId();

    const start = await request(app)
      .post('/api/v1/pairing/start')
      .send({ hardware_id, platform: 'router' });
    expect(start.status, JSON.stringify(start.body)).toBe(201);
    const code = start.body.code;

    const claim = await request(app)
      .post('/api/v1/pairing/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({ code, child_profile_id: childId });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);

    const poll = await request(app)
      .post('/api/v1/pairing/poll')
      .send({ code, hardware_id });
    expect(poll.status, JSON.stringify(poll.body)).toBe(200);
    const apiKey = poll.body.api_key;
    expect(apiKey).toMatch(/^mk_[a-f0-9]+$/);

    const resolve = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'example.com' });
    expect(resolve.status, JSON.stringify(resolve.body)).toBe(200);
  });
});
