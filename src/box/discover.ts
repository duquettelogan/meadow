/**
 * LAN device discovery.
 *
 * Two complementary signals:
 *   1. /proc/net/arp polling (always-on; zero deps; Linux-only).
 *      Catches every MAC the kernel has seen — every device that
 *      talks to anyone on the LAN, including silent IoT devices.
 *      Hostname unknown.
 *
 *   2. DHCP sniff on UDP/68 (best-effort; binds the client port with
 *      SO_REUSEADDR; no-op if the port is already held by an active
 *      DHCP client on the box). Captures DHCP DISCOVER/REQUEST
 *      broadcast traffic, which gives us the requesting MAC AND
 *      DHCP option 12 (host name) when the device announces one.
 *
 * Coalesced posting: new MACs are queued and flushed every
 * DISCOVER_INTERVAL_MS (default 30s). Failed posts re-queue.
 *
 * Auth: the box's API key (set on state.json by bootstrap). All
 * discovered devices land in the box's family — req.device.family_id
 * on the server side.
 *
 * Privacy posture (worth re-reading before changing anything here):
 *   - We send MAC + optional hostname + optional manufacturer string.
 *   - We do NOT send IP, source ports, captured packet bodies, or
 *     anything about which device is talking to which destination.
 *   - DHCP option 12 is the device's self-reported hostname, which
 *     parents have already accepted by configuring their devices —
 *     it's the same string mDNS surfaces.
 */

import * as dgram from 'dgram';
import * as fs from 'fs';
import { getBoxContext } from './context';
import { lookupOui } from './oui';

const API_URL = process.env.API_URL || process.env.MEADOW_API_URL || 'http://localhost:3000';
const DISCOVER_INTERVAL_MS = parseInt(
  process.env.DISCOVER_INTERVAL_MS ?? String(30_000),
  10,
);
const ARP_PATH = process.env.ARP_FILE || '/proc/net/arp';
const POST_TIMEOUT_MS = 5000;

interface PendingDiscovery {
  mac: string;
  hostname?: string;
  manufacturer?: string;
  firstSeen: number;
}

const pending = new Map<string, PendingDiscovery>();
// MACs we've already successfully POSTed at least once. Stops repeated
// ARP-poll cycles from flooding the audit_log.
const known = new Set<string>();

let pollTimer: NodeJS.Timeout | null = null;
let dhcpSocket: dgram.Socket | null = null;

export function startDiscovery(): void {
  if (pollTimer) return;
  if (process.env.DISABLE_DISCOVERY === '1') {
    console.log('[discover] disabled (DISABLE_DISCOVERY=1)');
    return;
  }

  // Try DHCP sniffing. Best-effort: if port 68 is already in use (an
  // active DHCP client on the box, dnsmasq, etc.) we silently skip.
  try {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => {
      console.warn('[discover] dhcp socket error:', (err as Error).message);
      try {
        sock.close();
      } catch {
        // ignore
      }
      dhcpSocket = null;
    });
    sock.on('message', handleDhcpPacket);
    sock.bind(68, () => {
      try {
        sock.setBroadcast(true);
      } catch {
        // ignore — we just receive
      }
    });
    dhcpSocket = sock;
  } catch (err) {
    console.warn(
      '[discover] DHCP sniff unavailable, falling back to ARP only:',
      (err as Error).message,
    );
    dhcpSocket = null;
  }

  // Primary loop: poll ARP, then flush pending. setInterval doesn't
  // re-enter — if a flush is slow, the next tick waits.
  pollTimer = setInterval(tick, DISCOVER_INTERVAL_MS);
  if (typeof pollTimer.unref === 'function') pollTimer.unref();

  // Initial tick after a short delay so the heartbeat module has a
  // chance to log first.
  setTimeout(tick, 5000).unref?.();

  console.log(
    `[discover] started — interval=${Math.floor(DISCOVER_INTERVAL_MS / 1000)}s, dhcp=${dhcpSocket ? 'on' : 'off'}`,
  );
}

export function stopDiscovery(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (dhcpSocket) {
    try {
      dhcpSocket.close();
    } catch {
      // ignore
    }
    dhcpSocket = null;
  }
}

async function tick(): Promise<void> {
  try {
    pollArp();
  } catch (err) {
    console.error('[discover] arp poll failed:', (err as Error).message);
  }
  try {
    await flushPending();
  } catch (err) {
    console.error('[discover] flush failed:', (err as Error).message);
  }
}

function pollArp(): void {
  if (!fs.existsSync(ARP_PATH)) return; // not on Linux / unavailable
  const raw = fs.readFileSync(ARP_PATH, 'utf-8');
  const lines = raw.split('\n').slice(1).filter(Boolean);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 6) continue;
    const mac = parts[3].toLowerCase();
    if (!isValidMac(mac)) continue;
    if (mac === '00:00:00:00:00:00') continue;
    record(mac);
  }
}

function handleDhcpPacket(msg: Buffer): void {
  // BOOTP/DHCP frame: chaddr at offset 28, 16 bytes (we only want
  // first 6 — that's the Ethernet MAC). DHCP options come after the
  // 4-byte magic cookie 99,130,83,99 at offset 236.
  if (msg.length < 240) return;
  const macBytes = msg.subarray(28, 34);
  const mac = Array.from(macBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(':');
  if (!isValidMac(mac) || mac === '00:00:00:00:00:00') return;
  const hostname = parseDhcpOption12(msg);
  record(mac, hostname);
}

/**
 * Walk DHCP options and return the value of option 12 (host name) if
 * present. Exported for unit testing.
 */
export function parseDhcpOption12(msg: Buffer): string | undefined {
  if (msg.length < 240) return undefined;
  // Verify magic cookie (99,130,83,99) at offset 236.
  if (
    msg[236] !== 99 ||
    msg[237] !== 130 ||
    msg[238] !== 83 ||
    msg[239] !== 99
  ) {
    return undefined;
  }
  let i = 240;
  while (i < msg.length) {
    const type = msg[i];
    if (type === 0xff) return undefined; // end-of-options
    if (type === 0) {
      i++;
      continue;
    } // pad
    const len = msg[i + 1];
    if (len === undefined) return undefined;
    if (type === 12) {
      try {
        return msg.subarray(i + 2, i + 2 + len).toString('utf-8');
      } catch {
        return undefined;
      }
    }
    i += 2 + len;
  }
  return undefined;
}

function record(mac: string, hostname?: string): void {
  if (known.has(mac) && !hostname) return; // stop noise from re-seeing same MAC

  const existing = pending.get(mac);
  if (existing) {
    if (hostname && !existing.hostname) existing.hostname = hostname;
    return;
  }
  pending.set(mac, {
    mac,
    hostname,
    manufacturer: lookupOui(mac),
    firstSeen: Date.now(),
  });
}

async function flushPending(): Promise<void> {
  const ctx = getBoxContext();
  if (!ctx?.api_key) return;

  const batch = Array.from(pending.values());
  pending.clear();

  for (const d of batch) {
    const ok = await postDiscovered(d, ctx.api_key);
    if (ok) {
      known.add(d.mac);
    } else {
      // Re-queue on failure so we retry next tick — but only if a
      // newer entry hasn't already taken its place.
      if (!pending.has(d.mac)) pending.set(d.mac, d);
    }
  }
}

async function postDiscovered(
  d: PendingDiscovery,
  apiKey: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_URL}/api/v1/devices/discovered`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        mac: d.mac,
        ...(d.hostname ? { hostname: d.hostname } : {}),
        ...(d.manufacturer ? { manufacturer: d.manufacturer } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[discover] api responded ${res.status} for ${d.mac}`);
      return false;
    }
    return true;
  } catch (err) {
    // Don't include err — fetch errors include the URL which would
    // leak the API host into journald on every attempt.
    console.error(`[discover] post failed for ${d.mac}`);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function isValidMac(mac: string): boolean {
  return /^[0-9a-f]{2}([:-][0-9a-f]{2}){5}$/i.test(mac);
}

/**
 * Test helpers.
 */
export function _resetDiscoveryForTests(): void {
  pending.clear();
  known.clear();
}
