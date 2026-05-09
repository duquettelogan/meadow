import { afterAll } from 'vitest';
import dotenv from 'dotenv';

// Load .env.test if present, fall back to .env.
dotenv.config({ path: '.env.test' });
dotenv.config(); // does not override already-set vars

// Provide test secrets if the env doesn't have them. Throwaway dev-only
// values — never use in production.
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = '0'.repeat(64);
}
if (!process.env.API_KEY_HMAC_SECRET) {
  process.env.API_KEY_HMAC_SECRET = '1'.repeat(64);
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgres://meadow:meadowdev@localhost:5432/meadow_test';
}
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = 'redis://localhost:6379';
}

// Disable the intel scheduler during tests.
process.env.DISABLE_SCHEDULER = '1';

// Disable rate limits during tests — the test suite blows through them
// otherwise (signup limiter is 5/hour, integration tests need way more).
process.env.DISABLE_RATE_LIMITS = '1';

// Don't bind UDP/53 in tests.
process.env.DNS_PORT = '0';

// Heartbeat is opt-out in tests — even though `app` imports don't start it
// (it's wired in src/index.ts main()), this is defense in depth in case a
// test accidentally imports index.ts later.
process.env.DISABLE_HEARTBEAT = '1';

// Same posture for the LAN discovery loop.
process.env.DISABLE_DISCOVERY = '1';

// And the silent-box offline alert watcher — tests drive
// runOfflineAlertCheckOnce() directly when they need to.
process.env.OFFLINE_ALERTS_DISABLED = '1';

// Box-side policy sync timer — same posture; tests drive
// refreshBoxPolicy() directly when they exercise box mode.
process.env.POLICY_SYNC_DISABLED = '1';

// Close the connection pool + Redis client after all tests so the
// process can exit cleanly.
afterAll(async () => {
  try {
    const { db } = await import('../src/db/connection');
    await db.end();
  } catch {
    // pool may already be closed
  }
  try {
    const { disconnectCache } = await import('../src/cache/index');
    await disconnectCache();
  } catch {
    // not connected
  }
  try {
    const { _disconnectForTests } = await import('../src/auth/revocation');
    await _disconnectForTests();
  } catch {
    // not connected
  }
});
