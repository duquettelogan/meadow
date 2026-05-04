import { runUpdate } from './updater';

/**
 * Manually run a single intel refresh and exit.
 *
 * Usage:
 *   npx ts-node src/intel/refresh.ts
 */
async function main() {
  await runUpdate();
  process.exit(0);
}

main().catch((err) => {
  console.error('refresh failed:', err);
  process.exit(1);
});
