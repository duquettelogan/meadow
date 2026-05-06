import { Request, Response, NextFunction } from 'express';
import { verifyParentTokenAsync, ParentClaims } from './jwt';
import { hashApiKey, getKeyPrefix, safeEqual } from './keys';
import { db } from '../db/connection';

declare module 'express-serve-static-core' {
  interface Request {
    parent?: ParentClaims;
    device?: { device_id: string; family_id: string; child_profile_id: string | null };
  }
}

function extractBearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Requires a valid (and non-revoked) parent JWT. Attaches req.parent.
 */
export async function requireParentAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearer(req);
  if (!token) {
    res.status(401).json({ error: 'missing authorization' });
    return;
  }
  const claims = await verifyParentTokenAsync(token);
  if (!claims) {
    res.status(401).json({ error: 'invalid or expired token' });
    return;
  }
  req.parent = claims;
  next();
}

/**
 * Requires a parent JWT AND that the parent owns the family in the URL.
 * Use on routes like /api/v1/families/:familyId/...
 */
export function requireParentForFamily(paramName = 'familyId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearer(req);
    if (!token) {
      res.status(401).json({ error: 'missing authorization' });
      return;
    }
    const claims = await verifyParentTokenAsync(token);
    if (!claims) {
      res.status(401).json({ error: 'invalid or expired token' });
      return;
    }
    const familyId = req.params[paramName];
    if (!familyId || familyId !== claims.family_id) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    req.parent = claims;
    next();
  };
}

/**
 * Requires a parent JWT AND that the parent owns the child in the URL.
 */
export function requireParentForChild(paramName = 'childId') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = extractBearer(req);
    if (!token) {
      res.status(401).json({ error: 'missing authorization' });
      return;
    }
    const claims = await verifyParentTokenAsync(token);
    if (!claims) {
      res.status(401).json({ error: 'invalid or expired token' });
      return;
    }
    const childId = req.params[paramName];
    if (!childId) {
      res.status(400).json({ error: 'child id required' });
      return;
    }
    try {
      const result = await db.query(
        'SELECT family_id FROM child_profiles WHERE id = $1',
        [childId],
      );
      if (
        result.rows.length === 0 ||
        result.rows[0].family_id !== claims.family_id
      ) {
        res.status(403).json({ error: 'forbidden' });
        return;
      }
      req.parent = claims;
      next();
    } catch (err) {
      console.error('parent-for-child auth failed:', err);
      res.status(500).json({ error: 'internal server error' });
    }
  };
}

/**
 * Requires a valid device API key. Attaches req.device.
 *
 * Lookup is by key prefix (indexed), then constant-time HMAC compare.
 */
export async function requireDeviceAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractBearer(req);
  if (!token || !token.startsWith('mk_')) {
    res.status(401).json({ error: 'missing or malformed device key' });
    return;
  }
  const prefix = getKeyPrefix(token);
  const hash = hashApiKey(token);

  try {
    const result = await db.query(
      `SELECT k.id as key_id, k.key_hash, k.device_id,
              d.family_id, d.child_profile_id
       FROM api_keys k
       JOIN devices d ON d.id = k.device_id
       WHERE k.key_prefix = $1 AND k.revoked_at IS NULL`,
      [prefix],
    );

    let matched: any = null;
    for (const row of result.rows) {
      if (safeEqual(row.key_hash, hash)) {
        matched = row;
        break;
      }
    }
    if (!matched) {
      res.status(401).json({ error: 'invalid device key' });
      return;
    }

    // Best-effort: update last_used_at. Failure here doesn't block.
    db.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [
      matched.key_id,
    ]).catch(() => {});

    req.device = {
      device_id: matched.device_id,
      family_id: matched.family_id,
      child_profile_id: matched.child_profile_id,
    };
    next();
  } catch (err) {
    console.error('device auth failed:', err);
    res.status(500).json({ error: 'internal server error' });
  }
}
