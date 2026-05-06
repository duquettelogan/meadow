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

async function main(): Promise<void> {
  const args = parse();

  const body: Record<string, string> = { mac: args.mac };
  if (args.hostname) body.hostname = args.hostname;
  if (args.manufacturer) body.manufacturer = args.manufacturer;

  const url = `${args.apiUrl.replace(/\/$/, '')}/api/v1/devices/discovered`;

  console.log(`POST ${url}`);
  console.log(`  body: ${JSON.stringify(body)}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${args.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // not json — fine
  }

  console.log(`\n← ${res.status} ${res.statusText}`);
  console.log(JSON.stringify(parsed, null, 2));

  if (!res.ok) process.exit(1);
}

main().catch((err) => {
  console.error('sim-discover failed:', err);
  process.exit(1);
});
