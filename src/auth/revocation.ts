import { createClient, RedisClientType } from 'redis';

/**
 * JWT revocation set (Phase 4.3).
 *
 * Backed by Redis. Stores revoked JWT IDs (jti) with a TTL that matches
 * the original token's remaining lifetime — once a token would have
 * expired naturally, we let the entry drop out of Redis.
 *
 * Use cases:
 *   - Parent logout: revoke just the current JWT.
 *   - Password change / reset: revoke ALL of that parent's tokens (call
 *     revokeAllForParent which sets a per-parent floor timestamp).
 *
 * Lookups are O(1). The jti is checked in middleware after JWT signature
 * verification; if revoked, the request is rejected as if expired.
 */

const PREFIX_JTI = 'meadow:revoked:jti:';
const PREFIX_PARENT_FLOOR = 'meadow:revoked:parent:';

let client: RedisClientType | null = null;
let connectPromise: Promise<void> | null = null;

function getClient(): RedisClientType {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('[revocation] redis error:', err));
  }
  return client;
}

// Single-flight connect — concurrent callers all wait on the same promise.
async function ensureConnected(): Promise<RedisClientType> {
  const c = getClient();
  if (c.isOpen) return c;
  if (!connectPromise) {
    connectPromise = c.connect().then(
      () => undefined,
      (err) => {
        connectPromise = null;
        throw err;
      },
    );
  }
  await connectPromise;
  return c;
}

/**
 * Revoke a single token by jti. ttlSeconds should be the token's
 * remaining lifetime (so the entry expires when the token would have
 * naturally — saves Redis memory).
 */
export async function revokeJti(jti: string, ttlSeconds: number): Promise<void> {
  if (!jti || ttlSeconds <= 0) return;
  try {
    const c = await ensureConnected();
    await c.set(`${PREFIX_JTI}${jti}`, '1', { EX: ttlSeconds });
  } catch (err) {
    console.error('[revocation] revokeJti failed:', err);
  }
}

/**
 * Set a "minimum issued-at" floor for a parent. Any JWT issued before
 * this timestamp is rejected. Used after password change / reset to
 * invalidate all existing sessions in one stroke.
 *
 * The floor is set to `floor(now/1000) + 1` so it's strictly greater
 * than any token's iat that exists at the moment of revocation. JWT iat
 * has 1-second resolution, so without the +1 bump, a token issued in
 * the same wall-clock second as the revocation would NOT be rejected by
 * the `floor > iat` check (they'd be equal). The +1 bump means anything
 * with iat <= now is correctly rejected. Trade-off: a re-login that
 * lands in the same physical second as the revocation gets rejected
 * once and the user has to retry — acceptable for the change-password
 * UX where the dashboard navigates to login first.
 */
export async function revokeAllForParent(parentId: string): Promise<void> {
  if (!parentId) return;
  try {
    const c = await ensureConnected();
    const floor = Math.floor(Date.now() / 1000) + 1;
    // 30-day TTL — anything older than the longest plausible session.
    await c.set(
      `${PREFIX_PARENT_FLOOR}${parentId}`,
      String(floor),
      { EX: 60 * 60 * 24 * 30 },
    );
  } catch (err) {
    console.error('[revocation] revokeAllForParent failed:', err);
  }
}

/**
 * Returns true if either:
 *  - the specific jti is on the revocation list, or
 *  - the parent's per-account floor is later than the token's iat.
 */
export async function isTokenRevoked(
  jti: string | undefined,
  parentId: string | undefined,
  iat: number | undefined,
): Promise<boolean> {
  try {
    const c = await ensureConnected();

    if (jti) {
      const hit = await c.get(`${PREFIX_JTI}${jti}`);
      if (hit) return true;
    }

    if (parentId && typeof iat === 'number') {
      const floor = await c.get(`${PREFIX_PARENT_FLOOR}${parentId}`);
      if (floor && parseInt(floor, 10) > iat) return true;
    }

    return false;
  } catch (err) {
    // Redis down: fail OPEN, not closed. Wedging all auth on Redis
    // would be a worse outage than a small revocation gap. Log loudly.
    console.error('[revocation] check failed (allowing token):', err);
    return false;
  }
}

/**
 * Test helper.
 */
export async function _disconnectForTests(): Promise<void> {
  if (client?.isOpen) {
    await client.disconnect();
  }
  client = null;
  connectPromise = null;
}
