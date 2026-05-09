import { db, testConnection } from './db/connection';
import { connectCache } from './cache/index';
import { loadBlocklist } from './cache/blocklist';
import { startScheduler, stopScheduler } from './intel/updater';
import { startDnsServer, stopDnsServer } from './dns/udp-server';
import { startHeartbeat, stopHeartbeat } from './box/heartbeat';
import { startDiscovery, stopDiscovery } from './box/discover';
import { loadBoxContext, getBoxContext } from './box/context';
import { startPolicySync, stopPolicySync } from './box/policy-sync';
import {
  startBlockReporter,
  stopBlockReporter,
  setApiKeyGetter,
} from './box/block-reporter';
import {
  startOfflineAlertWatcher,
  stopOfflineAlertWatcher,
} from './workers/box-offline-watcher';
import { app } from './api/server';
import { getMode, isBoxMode } from './mode';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  console.log(`Starting Meadow (mode=${getMode()})...`);
  if (isBoxMode()) {
    // Box mode: no Postgres at all. Filter policy comes from the cloud
    // API (PRs 3 + 4 wire that up); block events go back the same way.
    // Skip schema probe + the offline-alert watcher (server-side only).
    console.log('[startup] box mode — skipping DB connect, schema probe, offline-alert watcher');
  } else {
    await testConnection();
    console.log('Database connected.');
    await assertSchemaInPlace();
  }
  await connectCache();
  await loadBlocklist();
  startScheduler();

  // Start the UDP DNS server so devices on the LAN can use Meadow as
  // their DNS server. If the port can't be bound (e.g. running as
  // unprivileged user without CAP_NET_BIND_SERVICE on port 53), log
  // and continue — the API still works.
  try {
    await startDnsServer();
  } catch (err: any) {
    console.error('[dns] failed to start UDP server:', err.message);
    if (err.code === 'EACCES') {
      console.error('[dns] hint: port 53 requires root or CAP_NET_BIND_SERVICE.');
      console.error('[dns]       for local dev, set DNS_PORT=5353 in .env');
    }
    console.error('[dns] continuing without UDP DNS — API still functional.');
  }

  // Box-mode: prime the API-backed context cache and start the
  // 5-minute refresh loop. Heartbeat + discovery (below) need a
  // populated context to know what api_key to send.
  if (isBoxMode()) {
    await loadBoxContext();
    startPolicySync();
    // Block events: 30s-batched POST /box/blocks. The reporter reads
    // the api_key via this getter so a mid-process re-pair (api_key
    // rotation by refreshBoxPolicy) lands on the next flush.
    setApiKeyGetter(() => getBoxContext()?.api_key ?? null);
    startBlockReporter();
  }

  // Start the box-side heartbeat after DNS is up. No-op if state.json
  // doesn't exist (i.e. running as the API server, not a paired box).
  startHeartbeat();

  // LAN device discovery — ARP poll + best-effort DHCP sniff. Same
  // gating as heartbeat: no-op without a paired state.json + api_key.
  startDiscovery();

  // Server-side: hourly silent-box check that emails the family when
  // a box has had no heartbeat in >24h. No-op unless OFFLINE_ALERTS_DISABLED=1.
  // Box mode never runs this (no DB to query).
  if (!isBoxMode()) {
    startOfflineAlertWatcher();
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Meadow API running on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down...`);
    stopScheduler();
    stopHeartbeat();
    stopDiscovery();
    stopPolicySync();
    stopBlockReporter();
    stopOfflineAlertWatcher();
    await stopDnsServer().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Schema sanity probe.
 *
 * Run at boot — verifies the tables every recently-added migration
 * created actually exist in the database the app is pointed at. The
 * Dockerfile doesn't run migrations as part of `CMD`; they're a
 * separate manual step. Forgetting to run them shows up later as a
 * 500 on the first request that touches the missing table (e.g. the
 * /family/invite alpha-test 500 most likely came from migrate-012
 * not having been applied yet).
 *
 * Logs loud + exits non-zero so the process restart loop / fly logs
 * make the missing migration immediately obvious. Better than
 * limping along until a user trips over it.
 *
 * Add new tables to REQUIRED_TABLES whenever a migration adds one.
 */
const REQUIRED_TABLES = [
  'families',
  'parents',
  'child_profiles',
  'devices',
  'filter_policies',
  'block_counters',
  'pairing_codes',
  'api_keys',
  'audit_log',
  'family_invitations', // migrate-012
  'invite_codes', // migrate-013
];

async function assertSchemaInPlace(): Promise<void> {
  if (isBoxMode()) return; // never called from box-mode boot path; defense in depth.
  const result = await db.query(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [REQUIRED_TABLES],
  );
  const present = new Set(result.rows.map((r) => r.tablename));
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    console.error(
      `[startup] schema sanity check FAILED — missing tables: ${missing.join(', ')}`,
    );
    console.error(
      '[startup] run `npm run migrate` against this database before serving traffic.',
    );
    throw new Error(`missing tables: ${missing.join(', ')}`);
  }
  console.log(`[startup] schema sanity check OK (${present.size} tables present)`);
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
