/**
 * Simulated Meadow box.
 *
 * Pretends to be a Meadow hardware unit going through the pairing flow:
 *   1. Generates a stable hardware_id (or reads one from disk if present).
 *   2. Calls /api/v1/pairing/start to get a 6-digit code.
 *   3. Prints the code and instructions for the parent.
 *   4. Polls /api/v1/pairing/poll until claimed.
 *   5. Receives the API key and stores it locally.
 *   6. Validates the key works by hitting /api/v1/resolve.
 *
 * Usage:
 *   API_URL=http://localhost:3000 npx ts-node scripts/sim-device.ts
 *
 * To reset and re-pair:
 *   rm -rf .sim-device.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const STATE_FILE = process.env.STATE_FILE || '.sim-device.json';
const PLATFORM = process.env.PLATFORM || 'router';

interface State {
  hardware_id: string;
  api_key?: string;
  device_id?: string;
}

function loadState(): State {
  if (fs.existsSync(STATE_FILE)) {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  }
  const hardware_id = `hw_${crypto.randomBytes(16).toString('hex')}`;
  const state: State = { hardware_id };
  saveState(state);
  return state;
}

function saveState(state: State) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function api(path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function pair(state: State): Promise<void> {
  console.log('\n[sim-device] starting pairing...');
  const start = await api('/api/v1/pairing/start', {
    hardware_id: state.hardware_id,
    platform: PLATFORM,
  });

  if (start.status !== 201) {
    console.error('[sim-device] pairing/start failed:', start.body);
    process.exit(1);
  }

  const { code, expires_in_seconds } = start.body;
  const expiresMs = expires_in_seconds * 1000;
  const deadline = Date.now() + expiresMs;

  console.log('');
  console.log('   ┌──────────────────────────────────────────┐');
  console.log('   │                                          │');
  console.log(`   │   Pairing code:   ${code.padEnd(23)}│`);
  console.log('   │                                          │');
  console.log(`   │   Enter this in the parent dashboard.    │`);
  console.log(`   │   Expires in ${Math.floor(expires_in_seconds / 60)} minutes.                  │`);
  console.log('   │                                          │');
  console.log('   └──────────────────────────────────────────┘');
  console.log('');
  console.log('[sim-device] polling for claim...');

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await api('/api/v1/pairing/poll', {
      code,
      hardware_id: state.hardware_id,
    });

    if (poll.status === 200 && poll.body.status === 'ready') {
      state.api_key = poll.body.api_key;
      state.device_id = poll.body.device_id;
      saveState(state);
      console.log(`[sim-device] claimed! device_id=${poll.body.device_id}`);
      console.log(`[sim-device] api key stored in ${STATE_FILE}`);
      return;
    }

    if (poll.status === 202) {
      process.stdout.write('.');
      continue;
    }

    console.error('\n[sim-device] poll failed:', poll.status, poll.body);
    process.exit(1);
  }

  console.error('\n[sim-device] code expired without being claimed.');
  process.exit(1);
}

async function testResolve(state: State, domain: string): Promise<void> {
  if (!state.api_key) {
    console.error('[sim-device] no api key, cannot test');
    return;
  }
  const r = await api(
    '/api/v1/resolve',
    { domain },
    { Authorization: `Bearer ${state.api_key}` }
  );
  console.log(`[sim-device] resolve ${domain} →`, r.body);
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

async function main() {
  console.log('[sim-device] simulated Meadow box');
  console.log(`[sim-device] api: ${API_URL}`);

  const state = loadState();
  console.log(`[sim-device] hardware_id: ${state.hardware_id}`);

  if (!state.api_key) {
    await pair(state);
  } else {
    console.log('[sim-device] already paired, using stored key');
  }

  // Smoke test the key.
  await testResolve(state, 'cloudflare-dns.com'); // expect block
  await testResolve(state, 'google.com'); // expect allow

  while (true) {
    const input = await prompt('\n[sim-device] domain to test (or "quit"): ');
    if (!input || input === 'quit' || input === 'exit') break;
    await testResolve(state, input);
  }

  console.log('[sim-device] done.');
}

main().catch((err) => {
  console.error('[sim-device] crashed:', err);
  process.exit(1);
});
