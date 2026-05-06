import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `stats-${Date.now()}-${++counter}@example.com`;

async function makeFamily() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'statspw1234567' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

/**
 * Pull the synthetic Household child id for a family — that's where v1
 * block counters land via the resolver's family→Household JOIN. Tests
 * that want to seed counts use this so the data shows up in a parent's
 * stats response.
 */
async function householdChildId(family_id: string): Promise<string> {
  const r = await db.query(
    'SELECT id FROM child_profiles WHERE family_id = $1 AND is_household = true',
    [family_id],
  );
  expect(r.rows.length).toBe(1);
  return r.rows[0].id;
}

async function makeChild(token: string, name: string): Promise<string> {
  const r = await request(app)
    .post('/api/v1/children')
    .set('Authorization', `Bearer ${token}`)
    .send({ name });
  expect(r.status).toBe(201);
  return r.body.id as string;
}

/**
 * Seed a block_counters row for a child on (today - daysAgo).
 */
async function seedBlock(
  child_profile_id: string,
  category: string,
  count: number,
  daysAgo = 0,
): Promise<void> {
  await db.query(
    `INSERT INTO block_counters (child_profile_id, day, category, count)
     VALUES ($1, CURRENT_DATE - $2 * INTERVAL '1 day', $3, $4)
     ON CONFLICT (child_profile_id, day, category)
     DO UPDATE SET count = block_counters.count + EXCLUDED.count`,
    [child_profile_id, daysAgo, category, count],
  );
}

describe('GET /api/v1/stats/blocks', () => {
  it('rejects an unknown period with 400', async () => {
    const { token } = await makeFamily();
    const r = await request(app)
      .get('/api/v1/stats/blocks?period=year')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid period');
  });

  it('requires auth', async () => {
    const r = await request(app).get('/api/v1/stats/blocks?period=today');
    expect(r.status).toBe(401);
  });

  it('returns empty defaults for a family with no blocks', async () => {
    const { token } = await makeFamily();
    const r = await request(app)
      .get('/api/v1/stats/blocks?period=today')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      period: 'today',
      total_blocks: 0,
      by_category: [],
      by_day: [],
      by_child: [],
    });
  });

  it('period=today only counts today, even if older rows exist', async () => {
    const { token, family_id } = await makeFamily();
    const hh = await householdChildId(family_id);
    await seedBlock(hh, 'adult_content', 5, 0); // today
    await seedBlock(hh, 'adult_content', 99, 3); // 3 days ago — must NOT count

    const r = await request(app)
      .get('/api/v1/stats/blocks?period=today')
      .set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect(r.body.total_blocks).toBe(5);
    expect(r.body.by_category).toEqual([{ category: 'adult_content', count: 5 }]);
    expect(r.body.by_day).toHaveLength(1);
    expect(r.body.by_day[0].count).toBe(5);
  });

  it('period=week sums the trailing 7-day window (incl. today)', async () => {
    const { token, family_id } = await makeFamily();
    const hh = await householdChildId(family_id);
    await seedBlock(hh, 'malware', 1, 0);
    await seedBlock(hh, 'malware', 2, 5); // inside 7d window
    await seedBlock(hh, 'malware', 4, 6); // inside 7d window (boundary)
    await seedBlock(hh, 'malware', 8, 8); // OUTSIDE 7d window

    const r = await request(app)
      .get('/api/v1/stats/blocks?period=week')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.total_blocks).toBe(7); // 1 + 2 + 4
    expect(r.body.by_category).toEqual([{ category: 'malware', count: 7 }]);
    expect(r.body.by_day).toHaveLength(3);
  });

  it('period=month sums the trailing 30-day window (incl. today)', async () => {
    const { token, family_id } = await makeFamily();
    const hh = await householdChildId(family_id);
    await seedBlock(hh, 'phishing', 10, 0);
    await seedBlock(hh, 'phishing', 20, 29); // inside 30d window (boundary)
    await seedBlock(hh, 'phishing', 40, 30); // OUTSIDE 30d window

    const r = await request(app)
      .get('/api/v1/stats/blocks?period=month')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.total_blocks).toBe(30); // 10 + 20
  });

  it('aggregates by_category and by_child across multiple categories and children', async () => {
    const { token, family_id } = await makeFamily();
    const hh = await householdChildId(family_id);
    const emma = await makeChild(token, 'Emma');

    await seedBlock(hh, 'adult_content', 10, 0);
    await seedBlock(hh, 'malware', 4, 0);
    await seedBlock(emma, 'adult_content', 7, 0);

    const r = await request(app)
      .get('/api/v1/stats/blocks?period=today')
      .set('Authorization', `Bearer ${token}`);
    expect(r.body.total_blocks).toBe(21);

    // by_category sorted DESC by count.
    expect(r.body.by_category).toEqual([
      { category: 'adult_content', count: 17 },
      { category: 'malware', count: 4 },
    ]);

    // by_child includes Household + Emma (both populated). Order is by
    // count DESC.
    const counts = Object.fromEntries(
      r.body.by_child.map((c: { name: string; count: number }) => [c.name, c.count]),
    );
    expect(counts).toEqual({ Household: 14, Emma: 7 });
  });

  it('is family-scoped — parent A cannot see parent B blocks', async () => {
    const a = await makeFamily();
    const aHh = await householdChildId(a.family_id);
    await seedBlock(aHh, 'adult_content', 100, 0);

    const b = await makeFamily();
    const r = await request(app)
      .get('/api/v1/stats/blocks?period=today')
      .set('Authorization', `Bearer ${b.token}`);
    expect(r.status).toBe(200);
    expect(r.body.total_blocks).toBe(0);
    expect(r.body.by_category).toEqual([]);
    expect(r.body.by_child).toEqual([]);
  });
});
