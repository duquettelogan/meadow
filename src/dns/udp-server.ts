import dgram from 'dgram';
import { handleDnsQuery } from './handler';
import { loadBoxContext, getBoxContext } from '../box/context';

/**
 * UDP DNS server.
 *
 * Listens on the configured port (default 53) and serves DNS for all
 * devices on the LAN. This is the primary user-facing DNS endpoint —
 * what phones, laptops, consoles, smart TVs talk to.
 *
 * Binding port 53 requires root or CAP_NET_BIND_SERVICE. The systemd
 * unit grants the capability so the service can run as the unprivileged
 * `meadow` user. For local dev, set DNS_PORT=5353 to avoid the privilege
 * issue.
 *
 * Set DNS_PORT=0 to disable the UDP server entirely (e.g. in tests).
 *
 * On startup, this loads the box's pairing context once and caches the
 * resolved child_profile_id. Every blocked query attributes its counter
 * increment to that child. If the box isn't paired yet, blocks still
 * happen but no counters are written (blocked traffic is still safe —
 * we just won't surface it on the dashboard until pairing completes).
 */

const DNS_PORT = parseInt(process.env.DNS_PORT ?? '53', 10);
const BIND_HOST = process.env.DNS_HOST ?? '0.0.0.0';

let socket: dgram.Socket | null = null;

export async function startDnsServer(): Promise<void> {
  if (DNS_PORT === 0) {
    console.log('[dns] UDP server disabled (DNS_PORT=0)');
    return;
  }

  if (socket) {
    console.log('[dns] UDP server already running');
    return;
  }

  // Resolve the box's pairing context before opening the socket.
  // Failure is non-fatal — DNS still serves, just without counters.
  try {
    await loadBoxContext();
  } catch (err) {
    console.error('[dns] loadBoxContext failed (continuing without counters):', err);
  }

  await new Promise<void>((resolve, reject) => {
    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => {
      console.error('[dns] socket error:', err);
    });

    sock.on('message', async (msg, rinfo) => {
      try {
        const ctx = getBoxContext();
        const response = await handleDnsQuery(msg, {
          childProfileId: ctx?.child_profile_id ?? null,
        });
        sock.send(new Uint8Array(response), rinfo.port, rinfo.address, (err) => {
          if (err) {
            console.error('[dns] send error:', err);
          }
        });
      } catch (err) {
        console.error('[dns] handler error:', err);
      }
    });

    sock.once('listening', () => {
      const address = sock.address();
      console.log(
        `[dns] UDP server listening on ${address.address}:${address.port}`,
      );
      socket = sock;
      resolve();
    });

    sock.once('error', (err) => {
      reject(err);
    });

    try {
      sock.bind(DNS_PORT, BIND_HOST);
    } catch (err) {
      reject(err);
    }
  });
}

export function stopDnsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!socket) {
      resolve();
      return;
    }
    socket.close(() => {
      socket = null;
      resolve();
    });
  });
}
