import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/api/server';
import { db } from '../../src/db/connection';
import { verifyEmailFor } from '../helpers';

// Stub email adapter — count + capture calls so the test can assert
// without going through the console provider's stdout side effect.
//
// Why vi.hoisted instead of a plain top-level const: vitest moves
// vi.mock() ABOVE every static import in the file. The email module
// gets loaded transitively when `app` is imported on line 3, which
// triggers the mock factory while the test file's own body hasn't
// run yet. A naked `const sentEmails = []` is still in the temporal
// dead zone at that moment — the closure captures a TDZ binding and
// nothing ever lands in the array (alerted=1 but sentEmails.length=0,
// the exact symptom that hit CI on PR #20). vi.hoisted runs alongside
// the hoisted vi.mock so the binding exists before the factory closes
// over it.
const { sentEmails } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; subject: string }[],
}));
vi.mock('../../src/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/email')>();
  return {
    ...real,
    sendBoxOfflineEmail: vi.fn(async (to: string) => {
      sentEmails.push({ to, subject: 'Your Meadow box looks offline' });
    }),
    sendVerificationEmail: vi.fn(async () => {}),
    sendPasswordResetEmail: vi.fn(async () => {}),
  };
});

import { runOfflineAlertCheckOnce } from '../../src/workers/box-offline-watcher';

let counter = 0;
const uniqueEmail = () => `boxoff-${Date.now()}-${++counter}@example.com`;
const uniqueHwId = () =>
  `hw_${Date.now()}_${++counter}_${Math.random().toString(36).slice(2)}`;
const uniquePairingCode = () =>
  String(99_000_000 + Math.floor(Math.random() * 999_999))
    .padStart(8, '0')
    .replace(/(\d{4})(\d{4})/, '$1-$2');

async function makeFamily() {
  const email = uniqueEmail();
  const sig = await request(app)
    .post('/api/v1/auth/signup')
    .send({ email, password: 'boxoffpw1234567' });
  expect(sig.status).toBe(201);
  await verifyEmailFor(email);
  return {
    email,
    token: sig.body.token as string,
    family_id: sig.body.parent.family_id as string,
  };
}

/**
 * Spin up a real paired box for a family and return its device_id and
 * api_key. Walks the box-originated pairing flow end-to-end so the
 * api_keys row gets created and the worker's "boxes only" filter is
 * exercised against actual data, not mocks.
 */
async function pairBox(token: string): Promise<{
  device_id: string;
  api_key: string;
}> {
  const hardware_id = uniqueHwId();
  const code = uniquePairingCode();
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
    device_id: status.body.device_id,
    api_key: status.body.api_key,
  };
}

beforeEach(() => {
  sentEmails.length = 0;
});

// Each runOfflineAlertCheckOnce() sweeps EVERY paired box across
// EVERY family in the DB — that's its production contract. So when
// these tests run as part of the full suite, the global `alerted`
// count and the global `sentEmails` array can include rows seeded by
// other test files (or earlier tests in this file). Asserting on
// global counts is fragile; assert only on what each test actually
// owns: this family's email, and this device's offline_alert_sent_at.
//
// Helper: did THIS family get an offline email during the most recent
// sweep? (The mock pushes one entry per call.)
function emailsFor(email: string): { to: string; subject: string }[] {
  return sentEmails.filter((e) => e.to === email);
}

async function alertSentAt(deviceId: string): Promise<Date | null> {
  const row = await db.query(
    'SELECT offline_alert_sent_at FROM devices WHERE id = $1',
    [deviceId],
  );
  return row.rows[0]?.offline_alert_sent_at ?? null;
}

describe('runOfflineAlertCheckOnce', () => {
  it('emails the family + stamps offline_alert_sent_at when a box has been silent >24h', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    // Backdate last_seen to 26 hours ago.
    await db.query(
      `UPDATE devices SET last_seen = NOW() - INTERVAL '26 hours'
       WHERE id = $1`,
      [box.device_id],
    );

    const alerted = await runOfflineAlertCheckOnce();
    // alerted is the GLOBAL count for this sweep; suite-level state may
    // make it >1. Just ensure at least our box was picked up.
    expect(alerted).toBeGreaterThanOrEqual(1);

    expect(emailsFor(f.email)).toHaveLength(1);
    expect(await alertSentAt(box.device_id)).toBeTruthy();
  });

  it('does NOT re-email a box that has already been alerted', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    await db.query(
      `UPDATE devices
       SET last_seen = NOW() - INTERVAL '30 hours',
           offline_alert_sent_at = NOW() - INTERVAL '2 hours'
       WHERE id = $1`,
      [box.device_id],
    );
    const stampBefore = await alertSentAt(box.device_id);

    await runOfflineAlertCheckOnce();
    // No NEW email to THIS family, and the stamp didn't move.
    expect(emailsFor(f.email)).toHaveLength(0);
    const stampAfter = await alertSentAt(box.device_id);
    expect(stampAfter?.getTime()).toBe(stampBefore?.getTime());
  });

  it('skips non-box devices (no api_key)', async () => {
    const f = await makeFamily();

    // /devices/register without /auth/devices/:id/keys leaves a row
    // with no api_key — exactly the synthetic kind we want filtered.
    const child = await request(app)
      .post('/api/v1/children')
      .set('Authorization', `Bearer ${f.token}`)
      .send({ name: 'Emma' });

    const dev = await request(app)
      .post('/api/v1/devices/register')
      .set('Authorization', `Bearer ${f.token}`)
      .send({
        child_profile_id: child.body.id,
        platform: 'ios',
        device_token: `dt-noapikey-${Date.now()}-${counter}`,
      });
    expect(dev.status).toBe(201);

    await db.query(
      `UPDATE devices SET last_seen = NOW() - INTERVAL '40 hours'
       WHERE id = $1`,
      [dev.body.id],
    );

    await runOfflineAlertCheckOnce();
    // The non-box device must not get stamped (key check filters it
    // out) and our family must not receive an email.
    expect(await alertSentAt(dev.body.id)).toBeNull();
    expect(emailsFor(f.email)).toHaveLength(0);
  });

  it('skips boxes that are still inside the 24h silent window', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);
    await db.query(
      `UPDATE devices SET last_seen = NOW() - INTERVAL '6 hours'
       WHERE id = $1`,
      [box.device_id],
    );

    await runOfflineAlertCheckOnce();
    // Box is too recent — no email and no stamp.
    expect(emailsFor(f.email)).toHaveLength(0);
    expect(await alertSentAt(box.device_id)).toBeNull();
  });
});

describe('heartbeat clears offline_alert_sent_at on reconnect', () => {
  it('flips offline_alert_sent_at back to NULL when the box checks in', async () => {
    const f = await makeFamily();
    const box = await pairBox(f.token);

    // Mark the box as previously alerted.
    await db.query(
      `UPDATE devices SET offline_alert_sent_at = NOW() - INTERVAL '3 hours'
       WHERE id = $1`,
      [box.device_id],
    );

    const hb = await request(app)
      .post('/api/v1/devices/heartbeat')
      .set('Authorization', `Bearer ${box.api_key}`)
      .send({ ts: Math.floor(Date.now() / 1000) });
    expect(hb.status).toBe(204);

    const row = await db.query(
      'SELECT offline_alert_sent_at FROM devices WHERE id = $1',
      [box.device_id],
    );
    expect(row.rows[0].offline_alert_sent_at).toBeNull();
  });
});
