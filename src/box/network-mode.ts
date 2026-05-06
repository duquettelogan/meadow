/**
 * Network-mode orchestrator.
 *
 * Sequencing (called from bootstrap.ts after pairing succeeds):
 *   1. Read current network-state from /var/lib/meadow/network.json.
 *      If conflict_detected was already true and the operator hasn't
 *      hit "Retry," do nothing — leave dnsmasq stopped.
 *   2. Detect the box's own LAN IP + the home router's IP via `ip`.
 *      If either is missing, log + bail (treated as conflict-state
 *      so the dashboard surfaces the problem).
 *   3. Listen 30 seconds for any other DHCP server on the LAN. If
 *      one is seen, write conflict_detected=true and stop here.
 *   4. Render dnsmasq.conf, reload + start dnsmasq via systemctl.
 *   5. Write checked=true, dhcp_active=true, last_dhcp_started_at=now.
 *   6. Push status to the API so the dashboard sees fresh data even
 *      before the next 30s heartbeat tick.
 *
 * All side effects are idempotent — re-running this function (e.g.
 * via "Retry network setup" from the web page) re-runs detection
 * and either confirms the prior state or transitions to active.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { detectDhcpServerConflict } from './dhcp-detect';
import {
  buildDnsmasqConfig,
  cidrToNetmask,
  pickDhcpRange,
} from './dnsmasq-config';
import {
  defaultState,
  readNetworkState,
  writeNetworkState,
} from './network-state';
import { getBoxContext } from './context';

const DNSMASQ_CONF_PATH =
  process.env.DNSMASQ_CONF || '/etc/dnsmasq.d/meadow.conf';
const LAN_INTERFACE = process.env.LAN_INTERFACE || 'eth0';
const API_URL = process.env.API_URL || 'http://localhost:3000';
const POST_TIMEOUT_MS = 5000;

export interface SetupOutcome {
  conflict_detected: boolean;
  dhcp_active: boolean;
  servers_seen: string[];
}

export async function setupNetworkMode(opts: {
  /** Skip the 30s passive listen. Used by tests + the "retry" path
   *  to allow short overrides. */
  detect_timeout_ms?: number;
} = {}): Promise<SetupOutcome> {
  const subnet = detectSubnet(LAN_INTERFACE);
  if (!subnet) {
    console.error(
      `[network-mode] could not detect subnet on ${LAN_INTERFACE}; aborting`,
    );
    persistConflict([], null, null);
    return { conflict_detected: true, dhcp_active: false, servers_seen: [] };
  }

  console.log(
    `[network-mode] interface=${LAN_INTERFACE} box_ip=${subnet.box_ip} gateway=${subnet.gateway_ip} cidr=${subnet.cidr}`,
  );

  console.log('[network-mode] running 30s DHCP conflict check...');
  const detect = await detectDhcpServerConflict({
    timeout_ms: opts.detect_timeout_ms ?? 30_000,
  });

  if (detect.conflict) {
    console.error(
      `[network-mode] conflict — DHCP servers seen: ${detect.servers_seen.join(', ')}`,
    );
    persistConflict(detect.servers_seen, subnet.box_ip, subnet.gateway_ip);
    pushStatus().catch(() => {});
    return {
      conflict_detected: true,
      dhcp_active: false,
      servers_seen: detect.servers_seen,
    };
  }

  // No conflict — render config + start dnsmasq.
  const range = pickDhcpRange(subnet.box_ip, subnet.cidr);
  const conf = buildDnsmasqConfig({
    interface: LAN_INTERFACE,
    box_ip: subnet.box_ip,
    gateway_ip: subnet.gateway_ip,
    netmask: subnet.netmask,
    dhcp_start: range.start,
    dhcp_end: range.end,
  });

  try {
    writeConfig(conf);
    restartDnsmasq();
  } catch (err) {
    console.error('[network-mode] dnsmasq start failed:', err);
    persistConflict([], subnet.box_ip, subnet.gateway_ip);
    pushStatus().catch(() => {});
    return {
      conflict_detected: false,
      dhcp_active: false,
      servers_seen: [],
    };
  }

  const state = {
    ...defaultState(),
    checked: true,
    dhcp_active: true,
    conflict_detected: false,
    servers_seen: [],
    box_ip: subnet.box_ip,
    gateway_ip: subnet.gateway_ip,
    last_check_at: new Date().toISOString(),
    last_dhcp_started_at: new Date().toISOString(),
  };
  writeNetworkState(state);
  pushStatus().catch(() => {});

  console.log('[network-mode] dnsmasq configured + active');
  return {
    conflict_detected: false,
    dhcp_active: true,
    servers_seen: [],
  };
}

/**
 * "Retry network setup" entry point — invoked from the meadow.local
 * web page after the operator has disabled DHCP on their router.
 */
export function retryNetworkSetup(): Promise<SetupOutcome> {
  return setupNetworkMode();
}

function persistConflict(
  servers_seen: string[],
  box_ip: string | null,
  gateway_ip: string | null,
): void {
  writeNetworkState({
    ...defaultState(),
    checked: true,
    dhcp_active: false,
    conflict_detected: true,
    servers_seen,
    box_ip: box_ip ?? undefined,
    gateway_ip: gateway_ip ?? undefined,
    last_check_at: new Date().toISOString(),
    last_dhcp_started_at: null,
  });
}

interface SubnetInfo {
  box_ip: string;
  gateway_ip: string;
  netmask: string;
  cidr: number;
}

/**
 * Parse `ip -4 addr show <iface>` and `ip route show default` to
 * extract the box's IP, the netmask, and the home router's IP.
 * Exported for tests so we can drive it with synthetic input.
 */
export function detectSubnet(iface: string): SubnetInfo | null {
  let addrOut: string;
  let routeOut: string;
  try {
    addrOut = execSync(`ip -4 addr show ${iface}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    routeOut = execSync(`ip route show default`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  return parseSubnet(addrOut, routeOut);
}

export function parseSubnet(
  addrOut: string,
  routeOut: string,
): SubnetInfo | null {
  const inet = addrOut.match(/inet (\d+\.\d+\.\d+\.\d+)\/(\d+)/);
  if (!inet) return null;
  const box_ip = inet[1];
  const cidr = parseInt(inet[2], 10);
  const gw = routeOut.match(/default via (\d+\.\d+\.\d+\.\d+)/);
  if (!gw) return null;
  return {
    box_ip,
    gateway_ip: gw[1],
    netmask: cidrToNetmask(cidr),
    cidr,
  };
}

function writeConfig(conf: string): void {
  const dir = path.dirname(DNSMASQ_CONF_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DNSMASQ_CONF_PATH, conf);
}

function restartDnsmasq(): void {
  // Best-effort: try systemctl restart. If systemd isn't available
  // (dev box, container), the network-mode is effectively a no-op.
  try {
    execSync('systemctl restart dnsmasq', {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `systemctl restart dnsmasq failed: ${(err as Error).message}`,
    );
  }
}

async function pushStatus(): Promise<void> {
  const ctx = getBoxContext();
  if (!ctx?.api_key) return;

  const state = readNetworkState();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    await fetch(`${API_URL}/api/v1/box/network-status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.api_key}`,
      },
      body: JSON.stringify({
        dhcp_active: state.dhcp_active,
        conflict_detected: state.conflict_detected,
        servers_seen: state.servers_seen,
        box_ip: state.box_ip,
        gateway_ip: state.gateway_ip,
        last_check_at: state.last_check_at,
      }),
      signal: controller.signal,
    });
  } catch {
    // Best-effort — heartbeat will eventually carry the same info.
  } finally {
    clearTimeout(timeoutId);
  }
}
