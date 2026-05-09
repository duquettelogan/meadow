import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

let counter = 0;
const uniqueEmail = () => `repair-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniqueCode = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function makeFamily() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'repairpw1234567' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

async function pair(
  token: string,
  hardware_id: string,
): Promise<{ device_id: string; api_key: string; code: string }> {
  const code = uniqueCode();
  const reg = await request(app)
    .post('/api/v1/pairing/register')
    .send({ hardware_id, pairing_code: code, platform: 'router' });
  expect(reg.status).toBe(201);

  const claim = await request(app)
    .post('/api/v1/pairing/claim-by-code')
    .set('Authorization', `Bearer ${token}`)
    .send({ pairing_code: code });
  expect(claim.status).toBe(200);

  const status = await request(app).get(
    `/api/v1/pairing/box-status/${hardware_id}`,
  );
  expect(status.status).toBe(200);
  return {
    device_id: status.body.device_id,
    api_key: status.body.api_key,
    code,
  };
}

describe('re-pair after device delete', () => {
  it('full flow: pair → delete → re-pair with same hardware_id succeeds end-to-end', async () => {
    const f = await makeFamily();
    const hardware_id = uniqueHwId();

    // First pairing.
    const first = await pair(f.token, hardware_id);
    expect(first.device_id).toBeTruthy();
    expect(first.api_key).toMatch(/^mk_[a-f0-9]+$/);

    // Delete the device via the dashboard's endpoint.
    const del = await request(app)
      .delete(`/api/v1/devices/${first.device_id}`)
      .set('Authorization', `Bearer ${f.token}`);
    expect(del.status).toBe(204);

    // Re-pair: same hardware_id, fresh code.
    const second = await pair(f.token, hardware_id);
    expect(second.device_id).toBeTruthy();
    expect(second.api_key).toMatch(/^mk_[a-f0-9]+$/);

    // The new device row exists, the old one is gone.
    expect(second.device_id).not.toBe(first.device_id);
    const oldRow = await db.query('SELECT 1 FROM devices WHERE id = $1', [
      first.device_id,
    ]);
    expect(oldRow.rows.length).toBe(0);
  });

  it('DELETE /devices wipes EVERY pairing_codes row for the same hardware_id', async () => {
    // Belt-and-braces — the alpha-test 409 ("code already claimed")
    // implies SOMETHING leaves a claimed pairing_codes row behind for
    // this hardware_id past the delete. Static analysis says it
    // shouldn't happen with the current claim-by-code transaction,
    // but the DELETE handler now sweeps by hardware_id too, so any
    // claimed leftover (from a prior schema, a half-completed earlier
    // flow, or a manual psql touch) is also wiped.
    const f = await makeFamily();
    const hardware_id = uniqueHwId();
    const first = await pair(f.token, hardware_id);

    // Manually seed a SECOND pairing_codes row with the same
    // hardware_id, marked claimed, no device_id — simulating the
    // worst-case orphan: a row that wouldn't be caught by the old
    // device_id / api_key_id sweep alone.
    const orphan = uniqueCode();
    await db.query(
      `INSERT INTO pairing_codes
         (code, hardware_id, platform, expires_at, claimed_at)
       VALUES ($1, $2, 'router', NOW() + INTERVAL '10 minutes', NOW())`,
      [orphan, hardware_id],
    );

    const del = await request(app)
      .delete(`/api/v1/devices/${first.device_id}`)
      .set('Authorization', `Bearer ${f.token}`);
    expect(del.status).toBe(204);

    // Both rows for this hardware_id are gone.
    const remaining = await db.query(
      'SELECT code FROM pairing_codes WHERE hardware_id = $1',
      [hardware_id],
    );
    expect(remaining.rows).toHaveLength(0);

    // Re-pair works clean.
    const second = await pair(f.token, hardware_id);
    expect(second.device_id).toBeTruthy();
  });

  it('register sweeps unclaimed orphan pairing_codes for the same hardware_id', async () => {
    // The dashboard's DELETE /devices removes the CLAIMED pairing_codes
    // row, but a partial pair attempt — register-without-claim, the box
    // crashing mid-flow — can leave an UNCLAIMED orphan with the same
    // hardware_id behind. The new register should sweep that orphan so
    // /box-status returns the freshly-registered row, not the orphan.
    const f = await makeFamily();
    const hardware_id = uniqueHwId();

    const orphanCode = uniqueCode();
    await db.query(
      `INSERT INTO pairing_codes (code, hardware_id, platform, expires_at)
       VALUES ($1, $2, 'router', NOW() + INTERVAL '10 minutes')`,
      [orphanCode, hardware_id],
    );

    const fresh = await pair(f.token, hardware_id);
    expect(fresh.device_id).toBeTruthy();

    // Orphan was swept; only one pairing_codes row for this hw remains.
    const rows = await db.query(
      'SELECT code FROM pairing_codes WHERE hardware_id = $1',
      [hardware_id],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].code).toBe(fresh.code);
  });

  it('does NOT sweep an already-claimed pairing_codes row for the same hardware_id', async () => {
    // Defensive-cleanup must NOT touch claimed rows. If the box hits
    // /pairing/register a second time while it's still currently paired
    // (e.g., bad bootstrap state), the live row stays so the existing
    // box keeps working. The dashboard delete is what tears down a
    // claimed row, not a re-register.
    const f = await makeFamily();
    const hardware_id = uniqueHwId();
    const first = await pair(f.token, hardware_id);

    // Re-register with a different code while the prior one is still
    // claimed and live.
    const newCode = uniqueCode();
    const reg = await request(app)
      .post('/api/v1/pairing/register')
      .send({ hardware_id, pairing_code: newCode, platform: 'router' });
    expect(reg.status).toBe(201);

    // Both rows should exist: the still-claimed first pair AND the
    // new unclaimed register.
    const rows = await db.query(
      `SELECT code, claimed_at IS NOT NULL AS claimed
       FROM pairing_codes WHERE hardware_id = $1
       ORDER BY created_at ASC`,
      [hardware_id],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].code).toBe(first.code);
    expect(rows.rows[0].claimed).toBe(true);
    expect(rows.rows[1].code).toBe(newCode);
    expect(rows.rows[1].claimed).toBe(false);
  });
});
