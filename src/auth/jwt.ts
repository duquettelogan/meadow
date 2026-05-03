import jwt from 'jsonwebtoken';

/**
 * Parent dashboard JWTs.
 *
 * Issued on /auth/login, sent in Authorization: Bearer header on subsequent
 * requests. Expires in 24h — parents can re-login. We can add refresh
 * tokens later if 24h friction becomes a real complaint.
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
}

export function signParentToken(claims: ParentClaims): string {
  return jwt.sign(claims, SECRET(), {
    expiresIn: JWT_TTL_SECONDS,
    issuer: 'meadow',
    audience: 'meadow-dashboard',
  });
}

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
    };
  } catch {
    return null;
  }
}
