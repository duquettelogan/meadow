import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpDir: string;
let tmpFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meadow-net-'));
  tmpFile = path.join(tmpDir, 'network.json');
  process.env.NETWORK_STATE_FILE = tmpFile;
});

describe('network-state read/write', () => {
  it('returns defaults when file does not exist', async () => {
    const mod = await import('../../src/box/network-state');
    const s = mod.readNetworkState();
    expect(s.checked).toBe(false);
    expect(s.dhcp_active).toBe(false);
    expect(s.conflict_detected).toBe(false);
    expect(s.servers_seen).toEqual([]);
  });

  it('round-trips through write → read', async () => {
    // Re-import so the module picks up the new env var.
    const mod = await import('../../src/box/network-state');
    mod.writeNetworkState({
      checked: true,
      dhcp_active: true,
      conflict_detected: false,
      servers_seen: [],
      box_ip: '192.168.1.50',
      gateway_ip: '192.168.1.1',
      last_check_at: '2026-01-01T00:00:00Z',
      last_dhcp_started_at: '2026-01-01T00:00:01Z',
    });
    const s = mod.readNetworkState();
    expect(s.dhcp_active).toBe(true);
    expect(s.box_ip).toBe('192.168.1.50');
    expect(s.gateway_ip).toBe('192.168.1.1');
  });

  it('returns defaults when file is corrupt (parse failure swallowed)', async () => {
    fs.writeFileSync(tmpFile, '{not valid json');
    const mod = await import('../../src/box/network-state');
    const s = mod.readNetworkState();
    expect(s.checked).toBe(false);
  });
});
