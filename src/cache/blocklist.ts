import fetch from 'node-fetch';
import { createClient } from 'redis';
import dotenv from 'dotenv';

dotenv.config();

const BLOCKLIST_KEY = 'meadow:blocklist';
const BLOCKLIST_URL = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts';

function getClient() {
  const client = createClient({
    url: process.env.REDIS_URL,
    database: 1,
  });
  client.on('error', (err) => console.error('Redis error:', err));
  return client;
}

export async function loadBlocklist(): Promise<void> {
  const client = getClient();
  await client.connect();

  const existing = await client.sCard(BLOCKLIST_KEY);
  if (existing > 0) {
    console.log(`Blocklist already loaded (${existing} domains).`);
    await client.disconnect();
    return;
  }

  console.log('Downloading blocklist...');
  const response = await fetch(BLOCKLIST_URL);
  const text = await response.text();

  const domains: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && parts[0] === '0.0.0.0') {
      domains.push(parts[1].toLowerCase());
    }
  }

  console.log(`Parsed ${domains.length} domains. Loading into Redis...`);

  const CHUNK = 1000;
  for (let i = 0; i < domains.length; i += CHUNK) {
    await client.sAdd(BLOCKLIST_KEY, domains.slice(i, i + CHUNK));
  }

  console.log('Blocklist loaded.');
  await client.disconnect();
}

export async function isBlocked(domain: string): Promise<boolean> {
  const client = getClient();
  await client.connect();
  const result = await client.sIsMember(BLOCKLIST_KEY, domain.toLowerCase());
  await client.disconnect();
  return result === 1;
}