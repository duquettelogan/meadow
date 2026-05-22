import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  reportAuthFailure,
  reportAuthSuccess,
  _resetRepairForTests,
  _setExitFnForTests,
  _setRestartBootstrapFnForTests,
  _failureCountForTests,
  _repairInFlightForTests,
} from '../../src/box/repair';

const ORIGINAL_BOX_ENV_FILE = process.env.BOX_ENV_FILE;
const ORIGINAL_THRESHOLD = process.env.REPAIR_AUTH_THRESHOLD;

let tmpDir: string;
let boxEnvPath: string;
let exitSpy: ReturnType<typeof vi.fn>;
let restartSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meadow-repair-'));
  boxEnvPath = path.join(tmpDir, 'box.env');
  process.env.BOX_ENV_FILE = boxEnvPath;
  _resetRepairForTests();
  exitSpy = vi.fn();
  restartSpy = vi.fn(async () => undefined);
  _setExitFnForTests(exitSpy);
  _setRestartBootstrapFnForTests(restartSpy);
});

afterEach(() => {
  if (ORIGINAL_BOX_ENV_FILE === undefined) delete process.env.BOX_ENV_FILE;
  else process.env.BOX_ENV_FILE = ORIGINAL_BOX_ENV_FILE;
  if (ORIGINAL_THRESHOLD === undefined) delete process.env.REPAIR_AUTH_THRESHOLD;
  else process.env.REPAIR_AUTH_THRESHOLD = ORIGINAL_THRESHOLD;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetRepairForTests();
});

function writeBoxEnv(content: string) {
  fs.writeFileSync(boxEnvPath, content);
}

describe('reportAuthFailure / reportAuthSuccess', () => {
  it('one failure does not trigger repair', () => {
    reportAuthFailure('heartbeat');
    expect(_failureCountForTests()).toBe(1);
    expect(_repairInFlightForTests()).toBe(false);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(restartSpy).not.toHaveBeenCalled();
  });

  it('a success between failures resets the counter', () => {
    reportAuthFailure('heartbeat');
    reportAuthSuccess();
    reportAuthFailure('policy-sync');
    // Only the last failure is on the counter; threshold (2) not hit.
    expect(_failureCountForTests()).toBe(1);
    expect(_repairInFlightForTests()).toBe(false);
  });

  it('two consecutive failures (any sources) triggers repair', async () => {
    writeBoxEnv(
      [
        'MEADOW_HARDWARE_ID=hw_keepme',
        'MEADOW_API_KEY=mk_oldkey',
        'MEADOW_DEVICE_ID=dev-aaaa',
      ].join('\n') + '\n',
    );

    reportAuthFailure('heartbeat');
    reportAuthFailure('block-reporter');

    // Repair is async (uses await on restartBootstrapFn). Let microtasks flush.
    await new Promise((r) => setImmediate(r));

    expect(_repairInFlightForTests()).toBe(true);
    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(75);

    // box.env hardware_id preserved, api_key + device_id cleared.
    const rewritten = fs.readFileSync(boxEnvPath, 'utf-8');
    expect(rewritten).toContain('MEADOW_HARDWARE_ID=hw_keepme');
    expect(rewritten).toContain('MEADOW_API_KEY=\n');
    expect(rewritten).toContain('MEADOW_DEVICE_ID=\n');
    expect(rewritten).not.toContain('mk_oldkey');
    expect(rewritten).not.toContain('dev-aaaa');
  });

  it('subsequent reportAuthFailure during repair-in-flight is ignored', async () => {
    reportAuthFailure('heartbeat');
    reportAuthFailure('policy-sync'); // triggers repair
    await new Promise((r) => setImmediate(r));

    const exitCallsBefore = exitSpy.mock.calls.length;
    const restartCallsBefore = restartSpy.mock.calls.length;

    reportAuthFailure('block-reporter');
    reportAuthFailure('heartbeat');
    await new Promise((r) => setImmediate(r));

    expect(exitSpy.mock.calls.length).toBe(exitCallsBefore);
    expect(restartSpy.mock.calls.length).toBe(restartCallsBefore);
  });

  it('still exits even if systemctl restart errors', async () => {
    _setRestartBootstrapFnForTests(async () => {
      throw new Error('sudo not configured');
    });
    writeBoxEnv('MEADOW_HARDWARE_ID=hw\nMEADOW_API_KEY=mk_x\n');

    reportAuthFailure('heartbeat');
    reportAuthFailure('heartbeat');
    await new Promise((r) => setImmediate(r));

    // box.env was still cleared, and the process exit was still called.
    expect(exitSpy).toHaveBeenCalledWith(75);
    expect(fs.readFileSync(boxEnvPath, 'utf-8')).toContain('MEADOW_API_KEY=\n');
  });

  it('no box.env on disk → still tries to restart bootstrap + exit', async () => {
    // file simply absent.
    reportAuthFailure('heartbeat');
    reportAuthFailure('heartbeat');
    await new Promise((r) => setImmediate(r));

    expect(restartSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(75);
  });
});
