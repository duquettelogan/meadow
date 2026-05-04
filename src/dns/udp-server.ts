import dgram from 'dgram';
import { handleDnsQuery } from './handler';

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
 */

const DNS_PORT = parseInt(process.env.DNS_PORT ?? '53', 10);
const BIND_HOST = process.env.DNS_HOST ?? '0.0.0.0';

let socket: dgram.Socket | null = null;

export function startDnsServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (DNS_PORT === 0) {
      console.log('[dns] UDP server disabled (DNS_PORT=0)');
      resolve();
      return;
    }

    if (socket) {
      console.log('[dns] UDP server already running');
      resolve();
      return;
    }

    const sock = dgram.createSocket('udp4');

    sock.on('error', (err) => {
      console.error('[dns] socket error:', err);
    });

    sock.on('message', async (msg, rinfo) => {
      try {
        const response = await handleDnsQuery(msg);
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
        `[dns] UDP server listening on ${address.address}:${address.port}`
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
