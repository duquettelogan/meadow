import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { isTokenRevoked } from './revocation';

/**
 * Parent dashboard JWTs.
 *
 * Issued on /auth/login, sent in Authorization: Bearer header on subsequent
 * requests. Expires in 24h — parents can re-login. We can add refresh
 * tokens later if 24h friction becomes a real complaint.
 *
 * Each token gets a unique jti so we can revoke individual sessions on
 * logout. Combined with a per-parent "floor" timestamp in Redis, a
 * password change / reset invalidates every outstanding token at once.
 */

const JWT_TTL_SECONDS = 60 * 60 * 24;

const SECRET = (): string => {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    throw new Error('JWT_SECRET env var must be set and at least 32 chars');
  }
  return s;
};

export interface ParentClaims {
  parent_id: string;
  family_id: string;
  jti?: string;
  iat?: number;
  exp?: number;
}

export function signParentToken(claims: {
  parent_id: string;
  family_id: string;
}): string {
  return jwt.sign(claims, SECRET(), {
    expiresIn: JWT_TTL_SECONDS,
    issuer: 'meadow',
    audience: 'meadow-dashboard',
    // jti lets us revoke a specific session on logout.
    jwtid: crypto.randomBytes(12).toString('hex'),
  });
}

/**
 * Synchronous signature/expiry/format check ONLY. Does NOT consult the
 * revocation set — that requires Redis and an await. Use
 * verifyParentTokenAsync from middleware where revocation matters.
 *
 * Kept around because some non-request code paths (test helpers) still
 * want a sync check.
 */
export function verifyParentToken(token: string): ParentClaims | null {
  try {
    const decoded = jwt.verify(token, SECRET(), {
      issuer: 'meadow',
      audience: 'meadow-dashboard',
    }) as jwt.JwtPayload;
    if (
      typeof decoded.parent_id !== 'string' ||
      typeof decoded.family_id !== 'string'
    ) {
      return null;
    }
    return {
      parent_id: decoded.parent_id,
      family_id: decoded.family_id,
      jti: typeof decoded.jti === 'string' ? decoded.jti : undefined,
      iat: typeof decoded.iat === 'number' ? decoded.iat : undefined,
      exp: typeof decoded.exp === 'number' ? decoded.exp : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Full verification with revocation lookup. Returns null if the token
 * is invalid, expired, or has been revoked.
 */
export async function verifyParentTokenAsync(
  token: string,
): Promise<ParentClaims | null> {
  const claims = verifyParentToken(token);
  if (!claims) return null;
  if (await isTokenRevoked(claims.jti, claims.parent_id, claims.iat)) {
    return null;
  }
  return claims;
}

/**
 * Helper for the logout endpoint — derive the remaining TTL from a
 * verified token's exp claim. Returns 0 if missing/expired.
 */
export function remainingTtlSeconds(claims: ParentClaims): number {
  if (typeof claims.exp !== 'number') return JWT_TTL_SECONDS;
  const left = claims.exp - Math.floor(Date.now() / 1000);
  return Math.max(0, left);
}
