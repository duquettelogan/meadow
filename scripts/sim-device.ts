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

/**
 * Treat undici-level fetch failures (TCP reset, DNS hiccup, proxy
 * timeout, transient TLS error) as retryable. HTTP-level non-2xx
 * responses are NOT retried here — the caller decides what to do
 * with them.
 */
function isTransient(err: any): boolean {
  const code = err?.code ?? err?.cause?.code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' ||
      code === 'ETIMEDOUT' || code === 'ENOTFOUND' ||
      code === 'EAI_AGAIN' || code === 'EPIPE') {
    return true;
  }
  // undici wraps low-level errors in `TypeError: fetch failed` with the
  // real cause in err.cause. The bare message is also worth matching
  // for the cases where cause isn't populated.
  const msg = String(err?.message ?? '');
  return /fetch failed|network|socket hang up/i.test(msg);
}

/**
 * Wrap a single api() call with retry on transient network errors.
 * Up to maxAttempts tries with exponential backoff (1s → 16s, capped).
 * Non-transient errors (or HTTP responses themselves) bubble through
 * to the caller untouched on the first attempt.
 */
async function withRetry<T>(
  doCall: () => Promise<T>,
  label: string,
  maxAttempts = 5,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await doCall();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === maxAttempts) throw err;
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 16_000);
      console.warn(
        `[sim-device] ${label} transient error (attempt ${attempt}/${maxAttempts}, retrying in ${Math.floor(delayMs / 1000)}s): ${(err as Error)?.message ?? err}`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function pollBoxStatus(state: State) {
  return withRetry(
    () =>
      api(
        'GET',
        `/api/v1/pairing/box-status/${encodeURIComponent(state.hardware_id)}`,
      ),
    'box-status',
  );
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

function printCodeBox(code: string): void {
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
}

/**
 * Loop calling /pairing/box-status until the parent claims (200 ready)
 * or something terminal happens. Transient network errors are absorbed
 * via withRetry (5 attempts w/ exponential backoff per poll). Returns
 * normally once state.api_key is set; throws or process.exits on
 * unrecoverable conditions.
 */
async function pollUntilClaimed(state: State): Promise<void> {
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await pollBoxStatus(state);

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
      console.error(
        `\n[sim-device] pairing failed: ${status.body.status ?? 'gone'}`,
      );
      console.error('[sim-device] rm .sim-device.json and re-run to start over.');
      process.exit(1);
    }

    if (status.status === 404) {
      console.error(
        '\n[sim-device] our registration disappeared — re-registering',
      );
      delete state.pairing_code;
      saveState(state);
      return pair(state);
    }

    console.error(
      '\n[sim-device] unexpected box-status:',
      status.status,
      status.body,
    );
    process.exit(1);
  }
}

async function pair(state: State): Promise<void> {
  console.log('\n[sim-device] registering...');
  const code = await register(state);
  printCodeBox(code);
  console.log('[sim-device] polling box-status...');
  return pollUntilClaimed(state);
}

/**
 * Resume an in-flight pair without re-registering.
 *
 * Run when state.json already has a hardware_id but no api_key — the
 * sim may have crashed between /pairing/register and /box-status's
 * single-shot api_key reveal, OR the parent may have claimed in the
 * dashboard while we were down. Probe /box-status once: if the server
 * still has a registration for our hardware_id, latch onto it and
 * either fetch the key (if 'ready') or display the code we kept in
 * state.json and resume polling (if 'pending'). Anything else falls
 * through to a fresh /pairing/register.
 *
 * Returns true when the resume took (we either retrieved the key or
 * are now actively polling); false when the caller should run pair()
 * from scratch.
 */
async function tryResume(state: State): Promise<boolean> {
  console.log('[sim-device] checking server for existing registration...');
  let probe;
  try {
    probe = await pollBoxStatus(state);
  } catch (err) {
    console.warn(
      `[sim-device] resume probe failed after retries: ${(err as Error)?.message ?? err}`,
    );
    return false;
  }

  if (probe.status === 404) {
    console.log('[sim-device] no server-side registration; will register fresh');
    return false;
  }

  if (probe.status === 410) {
    console.log(
      `[sim-device] server-side registration gone (${probe.body?.status ?? 'expired'}); will register fresh`,
    );
    delete state.pairing_code;
    saveState(state);
    return false;
  }

  if (probe.status !== 200) {
    console.warn(
      `[sim-device] resume probe got unexpected status ${probe.status}; will register fresh`,
    );
    return false;
  }

  if (probe.body.status === 'ready') {
    state.api_key = probe.body.api_key;
    state.device_id = probe.body.device_id;
    delete state.pairing_code;
    saveState(state);
    console.log(
      `[sim-device] resumed pair: claimed! device_id=${probe.body.device_id}`,
    );
    return true;
  }

  // status === 'pending' — registered but unclaimed. We can resume the
  // wait IF we still have the code in state.json (so the operator
  // knows what to type). If not, the only sane path is a fresh
  // register that gives us a code we can display.
  if (!state.pairing_code) {
    console.log(
      '[sim-device] server has a registration but we lost the local code; re-registering',
    );
    return false;
  }
  console.log('[sim-device] resumed pair: registration found, awaiting claim');
  printCodeBox(state.pairing_code);
  console.log('[sim-device] polling box-status...');
  await pollUntilClaimed(state);
  return true;
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

  if (state.api_key) {
    console.log('[sim-device] already paired, using stored key');
  } else {
    // First try to pick up where a prior run left off (sim crashed
    // between register and the single-shot key reveal, OR parent
    // already claimed while we were down). Falls through to a fresh
    // pair() if there's no server-side registration to resume.
    const resumed = await tryResume(state);
    if (!resumed) await pair(state);
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
