import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Per-device verdict cache (Redis).
 *
 * Lazy-connect: the client is created at module load but the actual
 * `client.connect()` call is deferred until the first read/write. Two
 * reasons:
 *   - Production (src/index.ts main()) calls connectCache() at startup
 *     so the first request doesn't pay the connect latency. That still
 *     works because connectCache() now just delegates to ensureConnected.
 *   - Tests import app from src/api/server.ts directly without ever
 *     running main(). Pre-Phase-4, the first /resolve in a test would
 *     blow up with "client is closed" because connectCache was never
 *     called. Lazy-connect makes the same client work in both paths.
 *
 * Concurrent first-callers are deduped via a single shared connectPromise,
 * so we don't fire multiple connect()s in a race.
 */

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on('error', (err) => {
  console.error('Redis error:', err);
});

let connectPromise: Promise<void> | null = null;

async function ensureConnected(): Promise<void> {
  if (client.isOpen) return;
  if (!connectPromise) {
    connectPromise = client.connect().then(
      () => undefined,
      (err) => {
        connectPromise = null;
        throw err;
      },
    );
  }
  await connectPromise;
}

export async function connectCache() {
  await ensureConnected();
  console.log('Cache connected.');
}

export async function disconnectCache() {
  if (client.isOpen) {
    await client.disconnect();
  }
  connectPromise = null;
}

export async function getCachedVerdict(
  deviceToken: string,
  domain: string
): Promise<string | null> {
  await ensureConnected();
  const key = `verdict:${deviceToken}:${domain}`;
  return await client.get(key);
}

export async function setCachedVerdict(
  deviceToken: string,
  domain: string,
  verdict: string,
  ttlSeconds: number = 3600
): Promise<void> {
  await ensureConnected();
  const key = `verdict:${deviceToken}:${domain}`;
  await client.set(key, verdict, { EX: ttlSeconds });
}

export async function invalidateDevice(deviceToken: string): Promise<void> {
  await ensureConnected();
  const keys = await client.keys(`verdict:${deviceToken}:*`);
  if (keys.length > 0) {
    await client.del(keys);
  }
}
