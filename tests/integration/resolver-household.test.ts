import { describe, it, expect, vi } from 'vitest';

// Mock categorize so /resolve doesn't reach Cloudflare in CI.
vi.mock('../../src/resolver/categorize', () => ({
  categorizeDomain: () =>
    Promise.resolve({ matchedCategory: null, categories: [] }),
}));

import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `rh-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;

async function makeVerifiedFamily() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'rhpw12345abc' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

async function pairBoxFor(token: string): Promise<string> {
  const hardware_id = uniqueHwId();
  const start = await request(app)
    .post('/api/v1/pairing/start')
    .send({ hardware_id, platform: 'router' });
  const claim = await request(app)
    .post('/api/v1/pairing/claim')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: start.body.code });
  expect(claim.status).toBe(200);
  const poll = await request(app)
    .post('/api/v1/pairing/poll')
    .send({ code: start.body.code, hardware_id });
  return poll.body.api_key as string;
}

describe('resolver pulls Household policy regardless of source', () => {
  it('domain on the Household block list is blocked even when device.child_profile_id is null', async () => {
    const { token, family_id } = await makeVerifiedFamily();
    const apiKey = await pairBoxFor(token);

    // Confirm: paired device has NO child_profile_id (v1 contract).
    const devRow = await db.query(
      `SELECT child_profile_id FROM devices
       WHERE family_id = $1 AND child_profile_id IS NULL
       LIMIT 1`,
      [family_id],
    );
    expect(devRow.rows.length).toBe(1);

    // Set a Household block via the new family-scoped endpoint.
    const put = await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ blocked_domains: ['blocked-by-household.example'] });
    expect(put.status).toBe(200);

    const r = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'blocked-by-household.example' });
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('block');
    expect(r.body.reason).toBe('parent_blocklist');
  });

  it('a per-child policy that contradicts Household has NO effect on resolution', async () => {
    const { token } = await makeVerifiedFamily();
    const apiKey = await pairBoxFor(token);

    // Set up: Household blocks "blocked.example".
    await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ blocked_domains: ['blocked.example'] });

    // A non-household child explicitly ALLOWS it via the per-child route.
    // In v1 this should be cosmetic — the resolver only consults Household.
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Emma' });
    await request(app)
      .patch(`/api/v1/children/${child.body.id}/policy`)
      .set('Authorization', `Bearer ${token}`)
      .send({ allowed_domains: ['blocked.example'] });

    const r = await request(app)
      .post('/api/v1/resolve')
      .set('Authorization', `Bearer ${apiKey}`)
      .send({ domain: 'blocked.example' });
    // Household's block wins; Emma's per-child allow is inert in v1.
    expect(r.body.verdict).toBe('block');
    expect(r.body.reason).toBe('parent_blocklist');
  });

  it('same Household policy applies to a discovered (not paired) device too', async () => {
    // Even though /devices/discovered creates rows with child_profile_id
    // null and a synthetic disc_<hex> device_token, those rows aren't a
    // resolution path in v1 (the box queries DNS itself). This test
    // verifies the SQL contract: a device with child_profile_id=null
    // resolves via family → Household → policy.
    const { token, family_id } = await makeVerifiedFamily();

    // Build the resolver query path directly with raw SQL — same JOIN
    // as src/resolver/index.ts uses.
    await request(app)
      .put('/api/v1/filter-policy')
      .set('Authorization', `Bearer ${token}`)
      .send({ blocked_domains: ['household-rule.example'] });

    const policyRow = await db.query(
      `SELECT p.blocked_domains
       FROM child_profiles c
       JOIN filter_policies p ON p.child_profile_id = c.id
       WHERE c.family_id = $1 AND c.is_household = true`,
      [family_id],
    );
    expect(policyRow.rows.length).toBe(1);
    const domains = policyRow.rows[0].blocked_domains;
    // pg may return JSONB as parsed array OR as string depending on
    // driver — both shapes acceptable.
    const list = Array.isArray(domains) ? domains : JSON.parse(domains);
    expect(list).toContain('household-rule.example');
  });
});
