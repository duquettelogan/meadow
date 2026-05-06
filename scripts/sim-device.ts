/**
 * Simulated Meadow box.
 *
 * Walks the box-originated v1 pairing flow:
 *   1. Generates a stable hardware_id (or reads one from disk if present).
 *   2. Generates an 8-digit pairing code.
 *   3. POSTs /api/v1/pairing/register so the API knows about the box.
 *   4. Prints the code in a frame so the dev knows what to type into
 *      the dashboard's claim-by-code field.
 *   5. Polls /api/v1/pairing/box-status/:hardware_id until claimed.
 *   6. Receives the API key + device_id and stores them locally.
 *   7. Validates the key works by hitting /api/v1/resolve.
 *
 * Usage:
 *   API_URL=http://localhost:3000 npx ts-node scripts/sim-device.ts
 *
 * To reset and re-pair:
 *   rm -f .sim-device.json
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { generatePairingCode } from '../src/box/codegen';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const STATE_FILE = process.env.STATE_FILE || '.sim-device.json';
const PLATFORM = process.env.PLATFORM || 'router';
const POLL_INTERVAL_MS = 3000;

interface State {
  hardware_id: string;
  pairing_code?: string;
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

async function api(
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
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

async function register(state: State): Promise<string> {
  let code = state.pairing_code || generatePairingCode();

  for (let attempt = 0; attempt < 5; attempt++) {
    const reg = await api('POST', '/api/v1/pairing/register', {
      hardware_id: state.hardware_id,
      pairing_code: code,
      platform: PLATFORM,
    });
    if (reg.status === 201) {
      state.pairing_code = code;
      saveState(state);
      return code;
    }
    if (reg.status === 409) {
      console.log('[sim-device] pairing code collision, regenerating');
      code = generatePairingCode();
      continue;
    }
    console.error('[sim-device] /pairing/register failed:', reg.status, reg.body);
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error('[sim-device] could not register after 5 attempts');
  process.exit(1);
}

async function pair(state: State): Promise<void> {
  console.log('\n[sim-device] registering...');
  const code = await register(state);

  console.log('');
  console.log('   ┌──────────────────────────────────────────┐');
  console.log('   │                                          │');
  console.log(`   │   Pairing code:   ${code.padEnd(23)}│`);
  console.log('   │                                          │');
  console.log(`   │   Enter this in the parent dashboard     │`);
  console.log(`   │   (claim-by-code).                       │`);
  console.log('   │                                          │');
  console.log('   └──────────────────────────────────────────┘');
  console.log('');
  console.log('[sim-device] polling box-status...');

  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await api(
      'GET',
      `/api/v1/pairing/box-status/${encodeURIComponent(state.hardware_id)}`,
    );

    if (status.status === 200 && status.body.status === 'ready') {
      state.api_key = status.body.api_key;
      state.device_id = status.body.device_id;
      delete state.pairing_code;
      saveState(state);
      console.log(`\n[sim-device] claimed! device_id=${status.body.device_id}`);
      console.log(`[sim-device] api key stored in ${STATE_FILE}`);
      return;
    }

    if (status.status === 200 && status.body.status === 'pending') {
      process.stdout.write('.');
      continue;
    }

    if (status.status === 410) {
      console.error(`\n[sim-device] pairing failed: ${status.body.status ?? 'gone'}`);
      console.error('[sim-device] rm .sim-device.json and re-run to start over.');
      process.exit(1);
    }

    if (status.status === 404) {
      console.error('\n[sim-device] our registration disappeared — re-registering');
      delete state.pairing_code;
      saveState(state);
      return pair(state);
    }

    console.error('\n[sim-device] unexpected box-status:', status.status, status.body);
    process.exit(1);
  }
}

async function testResolve(state: State, domain: string): Promise<void> {
  if (!state.api_key) {
    console.error('[sim-device] no api key, cannot test');
    return;
  }
  const r = await api(
    'POST',
    '/api/v1/resolve',
    { domain },
    { Authorization: `Bearer ${state.api_key}` },
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
    }),
  );
}

async function main() {
  console.log('[sim-device] simulated Meadow box (v1 box-originated pairing)');
  console.log(`[sim-device] api: ${API_URL}`);

  const state = loadState();
  console.log(`[sim-device] hardware_id: ${state.hardware_id}`);

  if (!state.api_key) {
    await pair(state);
  } else {
    console.log('[sim-device] already paired, using stored key');
  }

  // Smoke test.
  await testResolve(state, 'cloudflare-dns.com'); // expect block (DoH bypass)
  await testResolve(state, 'google.com'); // expect allow / safe-search

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
