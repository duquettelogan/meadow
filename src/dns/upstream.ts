import dgram from 'dgram';

/**
 * Upstream DNS forwarder.
 *
 * Default mode: UDP/53 to Cloudflare 1.1.1.1. Fast, standard, what every
 * router does. We can swap to DoH later if we want stronger encryption
 * to upstream — but at home network scale UDP is fine and 100x faster.
 *
 * The upstream IP can be overridden with UPSTREAM_DNS env var
 * (comma-separated for multiple, tried in order):
 *   UPSTREAM_DNS=1.1.1.1,9.9.9.9
 */

const UPSTREAMS = (process.env.UPSTREAM_DNS || '1.1.1.1,1.0.0.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const UPSTREAM_PORT = 53;
const TIMEOUT_MS = 3000;

/**
 * Send a raw DNS query packet to upstream and return the raw response.
 * Tries each configured upstream in order. Throws if all fail.
 */
export async function forwardUpstream(query: Buffer): Promise<Buffer> {
  let lastError: unknown = null;
  for (const ip of UPSTREAMS) {
    try {
      return await sendUdpQuery(query, ip, UPSTREAM_PORT, TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      // Try next upstream.
    }
  }
  throw lastError ?? new Error('all upstream DNS servers failed');
}

function sendUdpQuery(
  query: Buffer,
  ip: string,
  port: number,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const isV6 = ip.includes(':');
    const socket = dgram.createSocket(isV6 ? 'udp6' : 'udp4');

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`upstream ${ip} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once('message', (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg);
    });

    socket.once('error', (err) => {
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.send(new Uint8Array(query), port, ip, (err) => {
      if (err) {
        clearTimeout(timer);
        socket.close();
        reject(err);
      }
    });
  });
}
