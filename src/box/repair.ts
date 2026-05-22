/**
 * Box self-repair on permanent credential revocation.
 *
 * Problem (Pi alpha follow-up, May 22): when the cloud invalidates a
 * device's api_key — DELETE /devices, a dashboard re-pair, or any
 * cascade that sweeps the api_keys row — the on-disk /etc/meadow/box.env
 * still holds the dead key. Nothing on the box notices automatically:
 * heartbeat, /box/policy refresh, and the block-flush loop all 401
 * forever with no recovery path. The DNS service stays running, but
 * the dashboard shows the box offline indefinitely until someone
 * manually clears box.env and restarts the bootstrap service.
 *
 * Recovery design:
 *   - Each API caller (heartbeat, policy-sync, block-reporter) reports
 *     401s via reportAuthFailure() and 2xx via reportAuthSuccess().
 *   - Two CONSECUTIVE failures (across ANY caller) is the threshold —
 *     defends against a single transient race during a key rotation
 *     without making the box sit dead for a third heartbeat interval.
 *   - On threshold hit, triggerRepair():
 *       1. Atomically rewrite box.env clearing MEADOW_API_KEY and
 *          MEADOW_DEVICE_ID (keeps MEADOW_HARDWARE_ID — the box re-pairs
 *          under the same stable identity).
 *       2. Best-effort `sudo systemctl restart meadow-bootstrap.service`.
 *          install.sh's sudoers fragment grants the meadow user
 *          permission to restart exactly this one service.
 *       3. Exit with code 75 (EX_TEMPFAIL). systemd's
 *          Restart=on-failure on meadow.service kicks in; meadow's
 *          Requires=meadow-bootstrap.service means the restart waits
 *          for bootstrap to finish (the freshly-restarted bootstrap
 *          sees the empty creds and runs a new pair flow).
 *
 * Idempotency: repairInFlight latch — multiple call sites detecting
 * 401 in the same instant race exactly once into triggerRepair, then
 * the process exits.
 */

import * as fs from 'fs';
import { spawn } from 'child_process';

const boxEnvFile = (): string =>
  process.env.BOX_ENV_FILE || '/etc/meadow/box.env';

const REPAIR_THRESHOLD = parseInt(
  process.env.REPAIR_AUTH_THRESHOLD ?? '2',
  10,
);

let consecutiveAuthFailures = 0;
let repairInFlight = false;
// Exit + spawn hooks are swappable so unit tests don't actually kill
// the test process or shell out to systemctl.
let exitFn: (code: number) => void = (code) => process.exit(code);
let restartBootstrapFn: () => Promise<void> = defaultRestartBootstrap;

export function reportAuthFailure(source: string): void {
  if (repairInFlight) return; // already in the middle of repair; ignore.
  consecutiveAuthFailures++;
  console.warn(
    `[repair] auth failure from ${source} (${consecutiveAuthFailures}/${REPAIR_THRESHOLD})`,
  );
  if (consecutiveAuthFailures >= REPAIR_THRESHOLD) {
    repairInFlight = true;
    void triggerRepair(source);
  }
}

export function reportAuthSuccess(): void {
  if (consecutiveAuthFailures > 0) {
    console.log('[repair] auth success — resetting failure counter');
    consecutiveAuthFailures = 0;
  }
}

async function triggerRepair(source: string): Promise<void> {
  console.error(
    `[repair] credentials appear permanently revoked (trigger=${source}); clearing box.env api_key and restarting meadow-bootstrap`,
  );
  try {
    clearCredsInBoxEnv();
  } catch (err) {
    console.error(
      '[repair] failed to clear box.env:',
      (err as Error).message,
    );
  }
  try {
    await restartBootstrapFn();
  } catch (err) {
    console.error(
      '[repair] systemctl restart meadow-bootstrap failed:',
      (err as Error).message,
    );
  }
  console.error(
    '[repair] exiting; systemd Restart=on-failure will bring us back once bootstrap re-pairs',
  );
  exitFn(75); // 75 = EX_TEMPFAIL (sysexits.h)
}

/**
 * Atomically rewrite box.env, blanking out MEADOW_API_KEY and
 * MEADOW_DEVICE_ID. Keeps MEADOW_HARDWARE_ID intact so the next
 * bootstrap re-pairs under the same identity.
 */
function clearCredsInBoxEnv(): void {
  const file = boxEnvFile();
  if (!fs.existsSync(file)) return;
  const lines = fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (t.startsWith('MEADOW_API_KEY=')) return 'MEADOW_API_KEY=';
      if (t.startsWith('MEADOW_DEVICE_ID=')) return 'MEADOW_DEVICE_ID=';
      return line;
    });
  const tmp = `${file}.repair-tmp`;
  fs.writeFileSync(tmp, lines.join('\n'), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function defaultRestartBootstrap(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'sudo',
      ['systemctl', 'restart', 'meadow-bootstrap.service'],
      { stdio: 'ignore' },
    );
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`systemctl exited ${code}`));
    });
    proc.on('error', reject);
  });
}

/**
 * Test helpers. Don't call in production.
 */
export function _resetRepairForTests(): void {
  consecutiveAuthFailures = 0;
  repairInFlight = false;
  exitFn = (code) => process.exit(code);
  restartBootstrapFn = defaultRestartBootstrap;
}

export function _setExitFnForTests(fn: (code: number) => void): void {
  exitFn = fn;
}

export function _setRestartBootstrapFnForTests(
  fn: () => Promise<void>,
): void {
  restartBootstrapFn = fn;
}

export function _failureCountForTests(): number {
  return consecutiveAuthFailures;
}

export function _repairInFlightForTests(): boolean {
  return repairInFlight;
}
