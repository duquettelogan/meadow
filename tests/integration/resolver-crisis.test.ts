import { describe, it, expect, vi } from 'vitest';

// Make sure categorize is never called on crisis or captive paths.
const categorizeSpy = vi.fn();
vi.mock('../../src/resolver/categorize', () => ({
  categorizeDomain: (...args: unknown[]) => {
    categorizeSpy(...args);
    return Promise.resolve({ matchedCategory: null, categories: [] });
  },
}));

import request from 'supertest';
import { app } from '../../src/api/server';

let counter = 0;
const uniqueEmail = () => `rc-${Date.now()}-${++counter}@example.com`;

async function makeDeviceKey() {
  const signup = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email: uniqueEmail(), password: 'resolverpw12345' });
  const token = signup.body.token;
  const child = await request(app)
    .post('/api/v1/children')
    .set('Authorization', `Bearer ${token}`)
    .send({ name: 'RKid' });
  const device = await request(app)
    .post('/api/v1/devices/register')
    .set('Authorization', `Bearer ${token}`)
    .send({
      child_profile_id: child.body.id,
      platform: 'router',
      device_token: `dt-rc-${Date.now()}-${counter}`,
    });
  const key = await request(app)
    .post(`/api/v1/auth/devices/${device.body.id}/keys`)
    .set('Authorization', `Bearer ${token}`);
  return key.body.key;
}

describe('HTTP resolver — crisis floor (Phase 1.4)', () => {
  it('returns allow with reason crisis_floor for crisis domains', async () => {
    const apiKey = await makeDeviceKey();
    const res = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: '988lifeline.org' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('allow');
    expect(res.body.reason).toBe('crisis_floor');
  });

  it('matches subdomains of crisis roots', async () => {
    const apiKey = await makeDeviceKey();
    const res = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'api.thetrevorproject.org' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('allow');
    expect(res.body.reason).toBe('crisis_floor');
  });

  it('captive portal also short-circuits before categorize', async () => {
    const apiKey = await makeDeviceKey();
    const res = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'captive.apple.com' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('allow');
    expect(res.body.reason).toBe('captive_portal');
  });
});
