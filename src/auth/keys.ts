import crypto from 'crypto';

/**
 * Device API keys.
 *
 * These are machine-generated 32-byte tokens, not human passwords. We
 * use HMAC-SHA256 instead of bcrypt because:
 *  - HMAC is fast (sub-millisecond) — the resolver path runs on every
 *    DNS request and bcrypt would add ~250ms per call.
 *  - The keys are high-entropy (256 bits of randomness), so brute-force
 *    is infeasible without a fast hash.
 *
 * Storage:
 *  - key_prefix: first 8 chars of the plaintext, for index lookup
 *  - key_hash:   hex(HMAC_SHA256(SERVER_SECRET, plaintext))
 *
 * The plaintext is shown to the parent ONCE at generation time and never
 * stored.
 */

const SECRET = (): string => {
  const s = process.env.API_KEY_HMAC_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      'API_KEY_HMAC_SECRET env var must be set and at least 32 chars'
    );
  }
  return s;
};

export interface GeneratedApiKey {
  plaintext: string; // shown to parent once, never stored
  prefix: string; // stored for fast lookup
  hash: string; // stored for verification
}

export function generateApiKey(): GeneratedApiKey {
  // 32 bytes → 64 hex chars. Prefix is the first 8 chars: "mk_" + 5 hex.
  const random = crypto.randomBytes(32).toString('hex');
  const plaintext = `mk_${random}`;
  const prefix = plaintext.slice(0, 8);
  const hash = hmac(plaintext);
  return { plaintext, prefix, hash };
}

export function hashApiKey(plaintext: string): string {
  return hmac(plaintext);
}

export function getKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, 8);
}

function hmac(input: string): string {
  return crypto.createHmac('sha256', SECRET()).update(input).digest('hex');
}

/**
 * Constant-time string comparison.
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}
