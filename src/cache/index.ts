import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const client = createClient({
  url: process.env.REDIS_URL,
});

client.on('error', (err) => {
  console.error('Redis error:', err);
});

export async function connectCache() {
  await client.connect();
  console.log('Cache connected.');
}

export async function getCachedVerdict(
  deviceToken: string,
  domain: string
): Promise<string | null> {
  const key = `verdict:${deviceToken}:${domain}`;
  return await client.get(key);
}

export async function setCachedVerdict(
  deviceToken: string,
  domain: string,
  verdict: string,
  ttlSeconds: number = 3600
): Promise<void> {
  const key = `verdict:${deviceToken}:${domain}`;
  await client.set(key, verdict, { EX: ttlSeconds });
}

export async function invalidateDevice(deviceToken: string): Promise<void> {
  const keys = await client.keys(`verdict:${deviceToken}:*`);
  if (keys.length > 0) {
    await client.del(keys);
  }
}