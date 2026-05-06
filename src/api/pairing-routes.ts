import express, { Request, Response } from 'express';
import crypto from 'crypto';
import { db } from '../db/connection';
import { generateApiKey } from '../auth/keys';
import { requireParentAuth, requireVerifiedParent } from '../auth/middleware';
import { validateBody } from './middleware';
import {
  PairingStartBody,
  PairingClaimBody,
  PairingPollBody,
} from './validation';
import { pairingClaimLimiter, pairingDeviceLimiter } from './rate-limits';
import { audit } from '../audit/log';

const router = express.Router();

const CODE_TTL_MINUTES = 10;

/**
 * Generate an 8-digit pairing code, formatted as XXXX-XXXX. 100M codes
 * means brute force at the rate-limited 10/15min ceiling takes 285 years
 * in expectation. v0 used 6 digits (1M space) — this is 100x harder.
 *
 * Uses crypto.randomInt for uniform distribution.
 */
function generatePairingCode(): string {
  const n = crypto.randomInt(0, 100_000_000);
  const padded = n.toString().padStart(8, '0');
  return `${padded.slice(0, 4)}-${padded.slice(4)}`;
}

function normalizeCode(input: string): string {
  // Accept both "1234-5678" and "12345678" — strip non-digits and reformat.
  const digits = input.replace(/\D/g, '');
  if (digits.length !== 8) return input;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/**
 * POST /api/v1/pairing/start
 * Device initiates pairing. Anonymous endpoint.
 *
 * Returns a code the parent will enter in the dashboard.
 */
router.post(
  '/start',
  pairingDeviceLimiter,
  validateBody(PairingStartBody),
  async (req: Request, res: Response) => {
    const { hardware_id, platform } = req.body as {
      hardware_id: string;
      platform: string;
    };

    try {
      // Generate a code, retry on the rare collision with an active code.
      let code = '';
      let inserted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        code = generatePairingCode();
        try {
          await db.query(
            `INSERT INTO pairing_codes (code, hardware_id, platform, expires_at)
             VALUES ($1, $2, $3, NOW() + INTERVAL '${CODE_TTL_MINUTES} minutes')`,
            [code, hardware_id, platform]
          );
          inserted = true;
          break;
        } catch (err: any) {
          if (err.code === '23505') continue; // unique violation, retry
          throw err;
        }
      }

      if (!inserted) {
        res.status(503).json({ error: 'could not generate pairing code, try again' });
        return;
      }

      // Best-effort: prune expired codes so the table stays small.
      db.query(
        `DELETE FROM pairing_codes
         WHERE expires_at < NOW() AND claimed_at IS NULL`
      ).catch(() => {});

      audit(req, 'pairing.started', {
        target_kind: 'pairing_code',
        metadata: { hardware_id: hardware_id.slice(0, 64), platform },
      });
      res.status(201).json({
        code,
        expires_in_seconds: CODE_TTL_MINUTES * 60,
      });
    } catch (err) {
      console.error('pairing/start failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

/**
 * POST /api/v1/pairing/claim
 * Parent claims a code from the dashboard, assigning the device to a child.
 */
router.post(
  '/claim',
  pairingClaimLimiter,
  requireParentAuth,
  requireVerifiedParent,
  validateBody(PairingClaimBody),
  async (req: Request, res: Response) => {
    const { code: rawCode, child_profile_id } = req.body as {
      code: string;
      child_profile_id: string;
    };
    const code = normalizeCode(rawCode);

    const client = await db.connect();
    try {
      await client.query('BEGIN');

      // Verify the child belongs to this parent's family.
      const childCheck = await client.query(
        `SELECT 1 FROM child_profiles
         WHERE id = $1 AND family_id = $2`,
        [child_profile_id, req.parent!.family_id]
      );
      if (childCheck.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'child not in your family' });
        return;
      }

      // Look up + lock the pairing row.
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

      // Create the device row in the parent's family.
      // The hardware_id from the pairing flow becomes the device_token —
      // the device already knows it, no new secret to communicate.
      const deviceResult = await client.query(
        `INSERT INTO devices (family_id, child_profile_id, platform, device_token, last_seen)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (device_token)
         DO UPDATE SET
           family_id = EXCLUDED.family_id,
           child_profile_id = EXCLUDED.child_profile_id,
           platform = EXCLUDED.platform,
           last_seen = NOW()
         RETURNING id`,
        [
          req.parent!.family_id,
          child_profile_id,
          row.platform,
          row.hardware_id,
        ]
      );
      const deviceId = deviceResult.rows[0].id;

      // Generate the API key. The plaintext is stored on the pairing row
      // briefly, then cleared as soon as the device polls for it.
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
             device_id = $2,
             api_key_id = $3,
             plaintext_key = $4
         WHERE id = $5`,
        [req.parent!.parent_id, deviceId, apiKeyId, key.plaintext, row.id]
      );

      await client.query('COMMIT');

      audit(req, 'pairing.claimed', {
        target_kind: 'device',
        target_id: deviceId,
        metadata: {
          child_profile_id,
          platform: row.platform,
        },
      });

      res.json({
        device_id: deviceId,
        child_profile_id,
        platform: row.platform,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('pairing/claim failed:', err);
      res.status(500).json({ error: 'internal server error' });
    } finally {
      client.release();
    }
  }
);

/**
 * POST /api/v1/pairing/poll
 * Device polls for the API key. Anonymous, but we verify hardware_id
 * matches the original request to prevent code-stealing.
 */
router.post(
  '/poll',
  pairingDeviceLimiter,
  validateBody(PairingPollBody),
  async (req: Request, res: Response) => {
    const { code: rawCode, hardware_id } = req.body as {
      code: string;
      hardware_id: string;
    };
    const code = normalizeCode(rawCode);

    try {
      const result = await db.query(
        `SELECT id, hardware_id, expires_at, claimed_at,
                device_id, plaintext_key
         FROM pairing_codes
         WHERE code = $1`,
        [code]
      );

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'invalid code' });
        return;
      }

      const row = result.rows[0];

      // Hardware ID must match. Mismatch = code-stealing attempt.
      if (row.hardware_id !== hardware_id) {
        audit(req, 'pairing.poll.hardware_mismatch', {
          target_kind: 'pairing_code',
          metadata: {
            expected_hw_prefix: String(row.hardware_id).slice(0, 16),
            got_hw_prefix: hardware_id.slice(0, 16),
          },
        });
        res.status(401).json({ error: 'hardware id mismatch' });
        return;
      }

      if (new Date(row.expires_at).getTime() < Date.now() && !row.claimed_at) {
        res.status(410).json({ error: 'code expired' });
        return;
      }

      if (!row.claimed_at) {
        res.status(202).json({ status: 'pending' });
        return;
      }

      if (!row.plaintext_key) {
        // Already retrieved once. Don't show the key again.
        res.status(410).json({ error: 'key already retrieved' });
        return;
      }

      const apiKey = row.plaintext_key as string;

      // Single-use: clear the plaintext immediately and mark revealed.
      // Even if delivery fails, we never show the same key twice.
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
      console.error('pairing/poll failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

export { router as pairingRouter };
