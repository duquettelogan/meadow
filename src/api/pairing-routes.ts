import express, { Request, Response } from 'express';
import { db } from '../db/connection';
import { generateApiKey } from '../auth/keys';
import { requireParentAuth, requireVerifiedParent } from '../auth/middleware';
import { validateBody } from './middleware';
import {
  PairingRegisterBody,
  ClaimByCodeBody,
} from './validation';
import { pairingClaimLimiter, pairingDeviceLimiter } from './rate-limits';
import { audit } from '../audit/log';

const router = express.Router();

const CODE_TTL_MINUTES = parseInt(
  process.env.PAIRING_CODE_TTL_MINUTES ?? '1440', // 24h default
  10,
);

function normalizeCode(input: string): string {
  // Accept "1234-5678" or "12345678" — strip non-digits and reformat.
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 8) return input;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/**
 * POST /api/v1/pairing/register
 *
 * Box-originated registration. Box generates the 8-digit code itself
 * and POSTs it here along with its hardware_id. The server stores an
 * unclaimed row in pairing_codes (family_id NULL, claimed_at NULL).
 * Anonymous endpoint — no parent auth.
 *
 * Idempotent on the (hardware_id, code) pair: a re-register with the
 * same hardware_id + same code refreshes expires_at on the existing
 * unclaimed row. A different hardware_id colliding on the code returns
 * 409 — the box regenerates and retries.
 *
 * Re-pair after dashboard delete: any UNCLAIMED leftover pairing_codes
 * row for this hardware_id is dropped first. The dashboard's
 * DELETE /devices handler removes the claimed row (and its api_key +
 * device row), but a partial pair attempt — register-without-claim,
 * the prior box session crashing mid-flow, etc. — can leave an
 * unclaimed orphan with the same hardware_id behind. The orphan
 * doesn't block the new code (the unique key is `code`, not
 * `hardware_id`), but it also confuses /box-status, which picks the
 * most recent row by created_at and would return the orphan's
 * "pending" state if the orphan was created after the new register.
 * Cleaning up here means box-status always sees exactly the row the
 * box just registered.
 *
 * Older /pairing/start (server-generated code) flow has been removed —
 * see docs/dashboard-api-notes.md.
 */
router.post(
  '/register',
  pairingDeviceLimiter,
  validateBody(PairingRegisterBody),
  async (req: Request, res: Response) => {
    const { hardware_id, pairing_code, platform } = req.body as {
      hardware_id: string;
      pairing_code: string;
      platform?: string;
    };
    const code = normalizeCode(pairing_code);

    try {
      // Best-effort: prune stale rows so the table stays small.
      db.query(
        `DELETE FROM pairing_codes
         WHERE expires_at < NOW() AND claimed_at IS NULL`
      ).catch(() => {});

      // Defensive cleanup: drop any unclaimed leftover pairing_codes
      // rows for this hardware_id (see comment block above). Awaited
      // because the new INSERT below relies on box-status returning the
      // freshly-registered row.
      await db.query(
        `DELETE FROM pairing_codes
         WHERE hardware_id = $1 AND claimed_at IS NULL`,
        [hardware_id]
      );

      // Try insert. ON CONFLICT (code) we have two cases:
      //   - same hardware_id and still unclaimed → refresh expires_at
      //     (won't actually happen post-cleanup above, but kept for
      //     defense in depth in case two registers race the cleanup)
      //   - different hardware_id, OR row already claimed → 409 (box
      //     regenerates and retries).
      const result = await db.query(
        `INSERT INTO pairing_codes (code, hardware_id, platform, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::interval)
         ON CONFLICT (code) DO UPDATE SET
           expires_at = NOW() + ($4 || ' minutes')::interval
         WHERE pairing_codes.hardware_id = EXCLUDED.hardware_id
           AND pairing_codes.claimed_at IS NULL
         RETURNING id`,
        [code, hardware_id, platform ?? 'router', String(CODE_TTL_MINUTES)]
      );

      if (result.rows.length === 0) {
        // ON CONFLICT was hit but the WHERE in DO UPDATE filtered it
        // out — same code, different hardware_id, OR already claimed.
        res.status(409).json({ error: 'pairing code in use' });
        return;
      }

      audit(req, 'pairing.started', {
        target_kind: 'pairing_code',
        metadata: {
          hardware_id: hardware_id.slice(0, 64),
          platform: platform ?? 'router',
        },
      });
      res.status(201).json({
        expires_in_seconds: CODE_TTL_MINUTES * 60,
      });
    } catch (err) {
      console.error('pairing/register failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

/**
 * POST /api/v1/pairing/claim-by-code
 *
 * Parent reads the code off the box's LAN web page (http://meadow.local)
 * and submits it via the dashboard. Server claims the unclaimed row,
 * stamps family_id + claimed_at, generates the API key, and returns
 * device_id. The actual api_key is delivered to the box on its next
 * /box-status/:hardware_id poll (single-shot reveal).
 */
router.post(
  '/claim-by-code',
  pairingClaimLimiter,
  requireParentAuth,
  requireVerifiedParent,
  validateBody(ClaimByCodeBody),
  async (req: Request, res: Response) => {
    const { pairing_code } = req.body as { pairing_code: string };
    const code = normalizeCode(pairing_code);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      const pairing = await client.query(
        `SELECT id, hardware_id, platform, expires_at, claimed_at
         FROM pairing_codes
         WHERE code = $1
         FOR UPDATE`,
        [code]
      );
      if (pairing.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'invalid code' });
        return;
      }

      const row = pairing.rows[0];
      if (row.claimed_at) {
        await client.query('ROLLBACK');
        res.status(409).json({ error: 'code already claimed' });
        return;
      }
      if (new Date(row.expires_at).getTime() < Date.now()) {
        await client.query('ROLLBACK');
        res.status(410).json({ error: 'code expired' });
        return;
      }

      // Create the device row in the parent's family — no child binding.
      // The box's hardware_id becomes the device_token.
      const deviceResult = await client.query(
        `INSERT INTO devices (family_id, child_profile_id, platform, device_token, last_seen)
         VALUES ($1, NULL, $2, $3, NOW())
         ON CONFLICT (device_token)
         DO UPDATE SET
           family_id = EXCLUDED.family_id,
           child_profile_id = NULL,
           platform = EXCLUDED.platform,
           last_seen = NOW()
         RETURNING id`,
        [req.parent!.family_id, row.platform, row.hardware_id]
      );
      const deviceId = deviceResult.rows[0].id;

      const key = generateApiKey();
      const apiKeyResult = await client.query(
        `INSERT INTO api_keys (device_id, key_prefix, key_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [deviceId, key.prefix, key.hash]
      );
      const apiKeyId = apiKeyResult.rows[0].id;

      await client.query(
        `UPDATE pairing_codes
         SET claimed_at = NOW(),
             claimed_by_parent_id = $1,
             family_id = $2,
             device_id = $3,
             api_key_id = $4,
             plaintext_key = $5
         WHERE id = $6`,
        [
          req.parent!.parent_id,
          req.parent!.family_id,
          deviceId,
          apiKeyId,
          key.plaintext,
          row.id,
        ]
      );

      await client.query('COMMIT');

      audit(req, 'pairing.claimed', {
        target_kind: 'device',
        target_id: deviceId,
        metadata: {
          platform: row.platform,
          family_id: req.parent!.family_id,
        },
      });

      res.json({
        device_id: deviceId,
        family_id: req.parent!.family_id,
        platform: row.platform,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('pairing/claim-by-code failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  }
);

/**
 * GET /api/v1/pairing/box-status/:hardware_id
 *
 * Box polls every ~10s while waiting to be claimed. Returns:
 *   - 200 {status: 'pending'}  — unclaimed
 *   - 200 {status: 'ready', api_key, device_id} — first poll after
 *                                                  claim. Single-shot:
 *                                                  plaintext_key clears
 *                                                  as soon as it's returned.
 *   - 410 {status: 'already_retrieved'} — claimed and key already
 *                                          fetched in a prior poll.
 *   - 410 {status: 'expired'} — pairing code expired before claim.
 *   - 404                       — no registration matches hardware_id.
 *
 * Anonymous (rate-limited via pairingDeviceLimiter). hardware_id is
 * derived from /etc/machine-id and not publicly known.
 */
router.get(
  '/box-status/:hardware_id',
  pairingDeviceLimiter,
  async (req: Request, res: Response) => {
    const hardware_id = req.params.hardware_id as string;
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(hardware_id)) {
      res.status(400).json({ error: 'invalid hardware_id' });
      return;
    }

    try {
      const result = await db.query(
        `SELECT id, expires_at, claimed_at, device_id, plaintext_key
         FROM pairing_codes
         WHERE hardware_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [hardware_id]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'no registration for hardware_id' });
        return;
      }

      const row = result.rows[0];

      if (!row.claimed_at) {
        if (new Date(row.expires_at).getTime() < Date.now()) {
          res.status(410).json({ status: 'expired' });
          return;
        }
        res.status(200).json({ status: 'pending' });
        return;
      }

      if (!row.plaintext_key) {
        res.status(410).json({ status: 'already_retrieved' });
        return;
      }

      const apiKey = row.plaintext_key as string;

      await db.query(
        `UPDATE pairing_codes
         SET plaintext_key = NULL,
             api_key_revealed_at = NOW()
         WHERE id = $1`,
        [row.id]
      );

      res.json({
        status: 'ready',
        api_key: apiKey,
        device_id: row.device_id,
      });
    } catch (err) {
      console.error('pairing/box-status failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

export { router as pairingRouter };
