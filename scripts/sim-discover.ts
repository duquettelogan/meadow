#!/usr/bin/env node
/**
 * sim-discover — manually fire a /api/v1/devices/discovered POST.
 *
 * Stand-in for the real LAN discovery loop on the box. Useful for
 * walking the dashboard through "device shows up unannounced" UX
 * without needing a Pi physically on the wire.
 *
 * Usage:
 *   npx ts-node scripts/sim-discover.ts \
 *     --mac aa:bb:cc:dd:ee:ff \
 *     --hostname living-room-tv \
 *     --manufacturer 'Sony Corp' \
 *     --api-url http://localhost:3000 \
 *     --api-key mk_<paired-box-key>
 *
 * The api-key is the box's mk_... key (the one written to
 * /etc/meadow/box.env after pairing). It scopes the device to the
 * box's family — same as the real discovery loop.
 */

import { parseArgs } from 'node:util';

interface Args {
  mac: string;
  hostname?: string;
  manufacturer?: string;
  apiUrl: string;
  apiKey: string;
}

function parse(): Args {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mac: { type: 'string' },
      hostname: { type: 'string' },
      manufacturer: { type: 'string' },
      'api-url': { type: 'string' },
      'api-key': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }
  if (!values.mac) die('--mac is required');
  if (!values['api-key']) die('--api-key is required');

  return {
    mac: String(values.mac),
    hostname: values.hostname ? String(values.hostname) : undefined,
    manufacturer: values.manufacturer ? String(values.manufacturer) : undefined,
    apiUrl: String(values['api-url'] ?? 'http://localhost:3000'),
    apiKey: String(values['api-key']),
  };
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  printUsage();
  process.exit(2);
}

function printUsage(): void {
  console.error(
    `usage: sim-discover --mac <mac> --api-key <mk_...> [--hostname <name>] [--manufacturer <vendor>] [--api-url <url>]`,
  );
}

/**
 * Best-effort sanity check on the key shape. Doesn't validate against
 * the server — just flags obvious typos before the round trip.
 *   - prefix `mk_` (set in src/auth/keys.ts; required for the
 *     server's prefix-indexed lookup)
 *   - hex body (`mk_[a-f0-9]+`)
 *   - reasonable length (issued keys are ~35 chars)
 */
function describeKey(key: string): string {
  const issues: string[] = [];
  if (!key.startsWith('mk_')) issues.push('missing mk_ prefix');
  if (!/^mk_[a-f0-9]+$/.test(key)) issues.push('non-hex characters');
  if (key.length < 11) issues.push(`length ${key.length} < 11 (too short)`);
  if (key.length > 80) issues.push(`length ${key.length} > 80 (too long)`);
  return issues.length ? `WARN ${issues.join(', ')}` : 'shape ok';
}

async function main(): Promise<void> {
  const args = parse();

  const body: Record<string, string> = { mac: args.mac };
  if (args.hostname) body.hostname = args.hostname;
  if (args.manufacturer) body.manufacturer = args.manufacturer;

  const url = `${args.apiUrl.replace(/\/$/, '')}/api/v1/devices/discovered`;

  // Server indexes api_keys on the first 8 chars of the plaintext (see
  // src/auth/keys.ts getKeyPrefix). Showing only the prefix lets the
  // operator verify the row exists and isn't revoked without copying
  // the full secret out of their terminal:
  //   psql ... -c "SELECT key_prefix, revoked_at FROM api_keys
  //                WHERE key_prefix='mk_xxxxx';"
  const keyPrefix = args.apiKey.slice(0, 8);

  console.log(`POST ${url}`);
  console.log(`  api-key:   ${keyPrefix}…  (len=${args.apiKey.length}, ${describeKey(args.apiKey)})`);
  console.log(`  body:      ${JSON.stringify(body)}`);

  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - startedAt;

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not json — fine
  }

  console.log(`\n← ${res.status} ${res.statusText}  (${elapsedMs}ms)`);
  // Surface the response headers most likely to explain a 4xx — content
  // type tells us if we hit an HTML error page (wrong host?), and
  // www-authenticate sometimes carries the auth scheme the server
  // wanted instead.
  for (const h of ['content-type', 'www-authenticate', 'x-request-id']) {
    const v = res.headers.get(h);
    if (v) console.log(`  ${h}: ${v}`);
  }
  console.log(JSON.stringify(parsed, null, 2));

  if (res.status === 401) {
    console.error(
      '\nhint: 401 from /devices/discovered means the device key didn’t resolve.\n' +
        '      common causes:\n' +
        '        • api-key was already consumed by the box on its first /box-status\n' +
        '          poll (single-shot reveal — re-pair, or pull mk_… off the box at\n' +
        '          /etc/meadow/box.env)\n' +
        `        • api-key is for a different env than --api-url (you hit ${args.apiUrl})\n` +
        '        • api-key was revoked — check api_keys.revoked_at for this prefix\n' +
        '        • mk_… was truncated by your shell (length above ↑ should match\n' +
        '          what /pairing/box-status returned, typically ~35 chars)',
    );
  }

  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error('sim-discover failed:', err);
  process.exit(1);
});
