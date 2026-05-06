/**
 * Box network mode state file.
 *
 * Persists the current DHCP-handoff state to /var/lib/meadow/network.json
 * so:
 *   - The pairing web page can render the conflict-detected UI without
 *     re-running the (slow) detection.
 *   - The /api/v1/box/network-status push has stable inputs.
 *   - A reboot picks up where it left off — if we'd already detected
 *     a conflict, don't auto-restart dnsmasq on next boot, wait for
 *     the operator to hit "Retry."
 */

import * as fs from 'fs';
import * as path from 'path';

export interface NetworkState {
  /** True once the conflict check has run at least once. */
  checked: boolean;
  /** True if dnsmasq is configured + (best-effort) running. */
  dhcp_active: boolean;
  /** True if another DHCP server was detected on the LAN. */
  conflict_detected: boolean;
  /** IPs of any DHCP servers seen during the last conflict check. */
  servers_seen: string[];
  /** Detected box IP at config time (informational). */
  box_ip?: string;
  /** Detected home-router IP at config time (informational). */
  gateway_ip?: string;
  /** Last time conflict detection finished. ISO-8601. */
  last_check_at: string | null;
  /** Last time dnsmasq was started/refreshed. ISO-8601. */
  last_dhcp_started_at: string | null;
}

// Resolved at call time, not module-load time — lets tests rotate the
// path via process.env.NETWORK_STATE_FILE between cases without doing
// vi.resetModules() gymnastics.
function statePath(): string {
  return process.env.NETWORK_STATE_FILE || '/var/lib/meadow/network.json';
}

export function defaultState(): NetworkState {
  return {
    checked: false,
    dhcp_active: false,
    conflict_detected: false,
    servers_seen: [],
    last_check_at: null,
    last_dhcp_started_at: null,
  };
}

export function readNetworkState(): NetworkState {
  const file = statePath();
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return { ...defaultState(), ...parsed };
  } catch (err) {
    console.error(`[network-state] failed to read ${file}:`, err);
    return defaultState();
  }
}

export function writeNetworkState(state: NetworkState): void {
  const file = statePath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Read the current dnsmasq lease count from the standard lease file
 * location. Used by the network-status report endpoint.
 */
export function readLeaseCount(): number {
  const leasePath =
    process.env.DNSMASQ_LEASES_FILE || '/var/lib/misc/dnsmasq.leases';
  try {
    const raw = fs.readFileSync(leasePath, 'utf-8');
    return raw.split('\n').filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}
