import express, { Request, Response } from 'express';
import { db } from '../db/connection';
import {
  hashPassword,
  verifyPassword,
  validatePassword,
} from '../auth/passwords';
import { signParentToken } from '../auth/jwt';
import { generateApiKey } from '../auth/keys';
import { requireParentAuth, requireParentForChild } from '../auth/middleware';

const router = express.Router();

function isValidEmail(email: unknown): email is string {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Signup: creates a family and the first parent, returns a JWT.
 *
 * Idempotency: if email already exists, returns 409.
 */
router.post('/signup', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'invalid email' });
    return;
  }
  const pwdError = validatePassword(password);
  if (pwdError) {
    res.status(400).json({ error: pwdError });
    return;
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const familyResult = await client.query(
      'INSERT INTO families (email) VALUES ($1) RETURNING id, email, created_at',
      [email]
    );
    const family = familyResult.rows[0];

    const passwordHash = await hashPassword(password);
    const parentResult = await client.query(
      `INSERT INTO parents (family_id, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, family_id, email, created_at`,
      [family.id, email, passwordHash]
    );
    const parent = parentResult.rows[0];

    await client.query('COMMIT');

    const token = signParentToken({
      parent_id: parent.id,
      family_id: parent.family_id,
    });

    res.status(201).json({
      token,
      parent: {
        id: parent.id,
        email: parent.email,
        family_id: parent.family_id,
      },
    });
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      res.status(409).json({ error: 'email already registered' });
      return;
    }
    console.error('signup failed:', err);
    res.status(500).json({ error: 'internal server error' });
  } finally {
    client.release();
  }
});

/**
 * Login: verifies password, returns JWT.
 *
 * Same response shape for "user not found" and "wrong password" to avoid
 * email enumeration.
 */
router.post('/login', async (req: Request, res: Response) => {
  const { email, password } = req.body ?? {};
  if (!isValidEmail(email) || typeof password !== 'string') {
    res.status(400).json({ error: 'invalid credentials' });
    return;
  }

  try {
    const result = await db.query(
      `SELECT id, family_id, password_hash
       FROM parents WHERE email = $1`,
      [email]
    );
    const row = result.rows[0];

    // Run bcrypt even if user is missing — keeps timing roughly constant.
    const dummyHash =
      '$2b$12$abcdefghijklmnopqrstuvCqDkJZ4dbVOq2nJpAZ.1/cVfMzQUvbq';
    const ok = await verifyPassword(
      password,
      row?.password_hash ?? dummyHash
    );

    if (!row || !ok) {
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    db.query('UPDATE parents SET last_login_at = NOW() WHERE id = $1', [
      row.id,
    ]).catch(() => {});

    const token = signParentToken({
      parent_id: row.id,
      family_id: row.family_id,
    });

    res.json({
      token,
      parent: { id: row.id, email, family_id: row.family_id },
    });
  } catch (err) {
    console.error('login failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
});

/**
 * /me — returns the current parent's identity. Useful for dashboard boot.
 */
router.get('/me', requireParentAuth, async (req: Request, res: Response) => {
  try {
    const result = await db.query(
      'SELECT id, family_id, email, created_at, last_login_at FROM parents WHERE id = $1',
      [req.parent!.parent_id]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: 'parent not found' });
      return;
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

/**
 * Generate a new API key for a device. Returns the plaintext key ONCE.
 * Parent must own the device's child.
 */
router.post(
  '/devices/:deviceId/keys',
  requireParentAuth,
  async (req: Request, res: Response) => {
    const { deviceId } = req.params;

    try {
      const owns = await db.query(
        `SELECT 1 FROM devices d
         WHERE d.id = $1 AND d.family_id = $2`,
        [deviceId, req.parent!.family_id]
      );
      if (owns.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }

      const key = generateApiKey();
      await db.query(
        `INSERT INTO api_keys (device_id, key_prefix, key_hash)
         VALUES ($1, $2, $3)`,
        [deviceId, key.prefix, key.hash]
      );

      // The plaintext is returned exactly once.
      res.status(201).json({
        key: key.plaintext,
        prefix: key.prefix,
        warning:
          'Store this key now. It will not be shown again.',
      });
    } catch (err) {
      console.error('key generation failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

/**
 * Revoke a device key.
 */
router.delete(
  '/devices/:deviceId/keys/:keyId',
  requireParentAuth,
  async (req: Request, res: Response) => {
    const { deviceId, keyId } = req.params;
    try {
      const owns = await db.query(
        `SELECT 1 FROM api_keys k
         JOIN devices d ON d.id = k.device_id
         WHERE k.id = $1 AND k.device_id = $2 AND d.family_id = $3`,
        [keyId, deviceId, req.parent!.family_id]
      );
      if (owns.rows.length === 0) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      await db.query(
        'UPDATE api_keys SET revoked_at = NOW() WHERE id = $1',
        [keyId]
      );
      res.json({ success: true });
    } catch (err) {
      console.error('key revocation failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  }
);

export { router as authRouter };
