import { testConnection } from './db/connection';
import { connectCache } from './cache/index';
import { loadBlocklist } from './cache/blocklist';
import { startScheduler, stopScheduler } from './intel/updater';
import { startDnsServer, stopDnsServer } from './dns/udp-server';
import { startHeartbeat, stopHeartbeat } from './box/heartbeat';
import { app } from './api/server';

const PORT = Number(process.env.PORT) || 3000;

async function main() {
  console.log('Starting Meadow...');
  await testConnection();
  console.log('Database connected.');
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

  // Start the box-side heartbeat after DNS is up. No-op if state.json
  // doesn't exist (i.e. running as the API server, not a paired box).
  startHeartbeat();

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Meadow API running on http://localhost:${PORT}`);
  });

  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] shutting down...`);
    stopScheduler();
    stopHeartbeat();
    await stopDnsServer().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
