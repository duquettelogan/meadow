/**
 * DHCP server conflict detection.
 *
 * Run BEFORE the box starts dnsmasq. Sends a synthetic DHCPDISCOVER
 * on the LAN and listens for OFFER replies. Any OFFER from any
 * server other than us = a real DHCP server is already on the
 * network (typically the home router) and we must NOT take over.
 *
 * The 30-second window matches the user-spec for first-boot safety:
 * long enough to catch slow/laggy home routers, short enough that a
 * customer plugging in the box doesn't sit watching a flashing LED
 * for ages.
 *
 * Implementation notes:
 *   - Binds UDP/68 with SO_REUSEADDR so it coexists with the box's
 *     own DHCP client (systemd-networkd) at boot. If 68 is somehow
 *     already exclusively held, the bind fails and we treat that as
 *     "indeterminate" — caller can choose to abort or assume safe.
 *   - The DISCOVER packet uses a random fake MAC and transaction id
 *     so we don't accidentally claim a lease for any real device on
 *     the LAN.
 *   - We do NOT send DHCPREQUEST after receiving an OFFER — we just
 *     observe.
 */

import * as dgram from 'dgram';
import * as crypto from 'crypto';

export interface ConflictDetectResult {
  conflict: boolean;
  servers_seen: string[];
  duration_ms: number;
  bind_failed: boolean;
}

interface Options {
  /** Listen window in milliseconds. Defaults to 30s per the spec. */
  timeout_ms?: number;
  /** Local address to bind. Defaults to 0.0.0.0 (all interfaces). */
  bind_address?: string;
}

export async function detectDhcpServerConflict(
  options: Options = {},
): Promise<ConflictDetectResult> {
  const timeout = options.timeout_ms ?? 30_000;
  const bindAddress = options.bind_address ?? '0.0.0.0';
  const start = Date.now();
  const seen = new Set<string>();
  let bindFailed = false;

  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve({
        conflict: seen.size > 0,
        servers_seen: Array.from(seen),
        duration_ms: Date.now() - start,
        bind_failed: bindFailed,
      });
    };

    socket.on('error', () => {
      bindFailed = true;
      finish();
    });

    socket.on('message', (msg, rinfo) => {
      // BOOTREPLY (op == 2) coming from a DHCP server. We don't
      // bother validating xid since we just want "did anyone reply
      // to a DISCOVER on the LAN at all?"
      if (msg.length < 240) return;
      if (msg[0] === 2) {
        seen.add(rinfo.address);
      }
    });

    socket.bind(68, bindAddress, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // not fatal — we may still receive broadcast OFFERs
      }
      const xid = crypto.randomBytes(4);
      const fakeMac = crypto.randomBytes(6);
      const discover = buildDhcpDiscover(xid, fakeMac);
      socket.send(
        new Uint8Array(discover),
        0,
        discover.length,
        67,
        '255.255.255.255',
        () => {
          // ignore send error — we still wait for any unsolicited
          // OFFERs from servers that broadcast on power-on
        },
      );
    });

    setTimeout(finish, timeout);
  });
}

/**
 * Build a minimal DHCPDISCOVER packet (BOOTREQUEST). 240 bytes of
 * BOOTP header + DHCP magic cookie + a few options.
 */
export function buildDhcpDiscover(xid: Buffer, chaddr: Buffer): Buffer {
  const buf = Buffer.alloc(244, 0);
  buf[0] = 1; // op = BOOTREQUEST
  buf[1] = 1; // htype = ethernet
  buf[2] = 6; // hlen = 6
  buf[3] = 0; // hops
  xid.copy(buf, 4); // transaction id
  // secs (8-9), flags (10-11), ciaddr (12-15), yiaddr (16-19),
  // siaddr (20-23), giaddr (24-27) all zeros — fine.
  // chaddr (28-43): only first 6 bytes are MAC.
  chaddr.copy(buf, 28);
  // sname (64-127), file (128-235) — zeros.
  // Magic cookie at offset 236.
  buf[236] = 99;
  buf[237] = 130;
  buf[238] = 83;
  buf[239] = 99;
  // Option 53 (DHCP message type) = 1 (DISCOVER)
  buf[240] = 53;
  buf[241] = 1;
  buf[242] = 1;
  // Option 255 (end)
  buf[243] = 0xff;
  return buf;
}
