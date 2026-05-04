import { testConnection } from './db/connection';
import { connectCache } from './cache/index';
import { loadBlocklist } from './cache/blocklist';
import { startScheduler, stopScheduler } from './intel/updater';
import { app } from './api/server';

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('Starting Meadow...');
  await testConnection();
  console.log('Database connected.');
  await connectCache();
  await loadBlocklist();
  startScheduler();

  const server = app.listen(PORT, () => {
    console.log(`Meadow API running on http://localhost:${PORT}`);
  });

  // Graceful shutdown — stop the scheduler so we don't leak the timer
  // when the process restarts.
  const shutdown = (signal: string) => {
    console.log(`\n[${signal}] shutting down...`);
    stopScheduler();
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
