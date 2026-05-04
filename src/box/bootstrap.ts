/**
 * Meadow box bootstrap.
 *
 * Runs once at boot via systemd (Type=oneshot, RemainAfterExit=yes).
 * If the box has never paired, it generates a hardware id, requests a
 * pairing code from the API, prints the code to stdout (captured by
 * journald) and polls until a parent claims it. Once paired, the API
 * key + device_id are persisted to /etc/meadow/state.json (mode 0600).
 *
 * The main meadow.service depends on this unit so the DNS server only
 * starts once a device_id is known.
 *
 * Env:
 *   API_URL      base URL of the meadow API (default http://localhost:3000)
 *   STATE_FILE   override state file path (default /etc/meadow/state.json)
 *   PLATFORM     reported platform string (default 'meadow-box')
 *
 * Reset / re-pair:  rm /etc/meadow/state.json && systemctl restart meadow-bootstrap
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const API_URL = process.env.API_URL || 'http://localhost:3000';
const STATE_FILE = process.env.STATE_FILE || '/etc/meadow/state.json';
const PLATFORM = process.env.PLATFORM || 'meadow-box';
const MACHINE_ID_PATH = '/etc/machine-id';

interface State {
  hardware_id: string;
  api_key?: string;
  device_id?: string;
}

function log(msg: string) {
  console.log(`[bootstrap] ${msg}`);
}

function err(msg: string) {
  console.error(`[bootstrap] ${msg}`);
}

/**
 * Derive a stable hardware id. Prefer /etc/machine-id (systemd, present on
 * every Pi OS / Debian / Ubuntu install, stable across reboots, not exposed
 * on the network). Fall back to a persisted random id for dev environments
 * that don't have machine-id readable.
 */
function deriveHardwareId(): string {
  try {
    const raw = fs.readFileSync(MACHINE_ID_PATH, 'utf-8').trim();
    if (raw.length > 0) {
      // Hash so we don't leak the literal machine-id over the wire.
      const h = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
      return `hw_${h}`;
    }
  } catch {
    // fall through
  }
  return `hw_${crypto.randomBytes(16).toString('hex')}`;
}

function ensureStateDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function loadState(): State {
  ensureStateDir();
  if (fs.existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
      if (parsed && typeof parsed.hardware_id === 'string') {
        return parsed;
      }
      err(`state file ${STATE_FILE} is malformed, regenerating`);
    } catch (e) {
      err(`failed to parse ${STATE_FILE}: ${(e as Error).message}, regenerating`);
    }
  }
  const state: State = { hardware_id: deriveHardwareId() };
  saveState(state);
  return state;
}

function saveState(state: State) {
  ensureStateDir();
  // Write atomically via temp file + rename so a crash mid-write can't
  // corrupt the state file.
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  // Defensive: ensure final perms are 0600 even if umask / FS played games.
  try {
    fs.chmodSync(STATE_FILE, 0o600);
  } catch {
    // best effort
  }
}

async function api(
  endpoint: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(`${API_URL}${endpoint}`, {
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
  log('starting pairing...');
  const start = await api('/api/v1/pairing/start', {
    hardware_id: state.hardware_id,
    platform: PLATFORM,
  });

  if (start.status !== 201) {
    err(`pairing/start failed: ${start.status} ${JSON.stringify(start.body)}`);
    process.exit(1);
  }

  const { code, expires_in_seconds } = start.body;
  const deadline = Date.now() + expires_in_seconds * 1000;

  // Box has no display in v1 — code goes to journald. Operator can read
  // via `journalctl -u meadow-bootstrap`. TODO: drive an LED/e-ink display
  // once Dane's enclosure is finalized.
  log('');
  log(`PAIRING CODE: ${code}`);
  log(`(expires in ${Math.floor(expires_in_seconds / 60)} minutes)`);
  log('Enter this in the parent dashboard.');
  log('');
  log('polling for claim...');

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const poll = await api('/api/v1/pairing/poll', {
      code,
      hardware_id: state.hardware_id,
    });

    if (poll.status === 200 && poll.body?.status === 'ready') {
      state.api_key = poll.body.api_key;
      state.device_id = poll.body.device_id;
      saveState(state);
      log(`claimed. device_id=${poll.body.device_id}`);
      log(`credentials persisted to ${STATE_FILE}`);
      return;
    }

    if (poll.status === 202) continue;

    err(`poll failed: ${poll.status} ${JSON.stringify(poll.body)}`);
    process.exit(1);
  }

  err('code expired without being claimed');
  process.exit(1);
}

async function main() {
  log(`api: ${API_URL}`);
  log(`state file: ${STATE_FILE}`);

  const state = loadState();
  log(`hardware_id: ${state.hardware_id}`);

  if (state.api_key && state.device_id) {
    log('already paired, exiting');
    return;
  }

  await pair(state);
  log('bootstrap complete');
}

main().catch((e) => {
  err(`crashed: ${(e as Error).stack || e}`);
  process.exit(1);
});
