import { testConnection } from './db/connection';
import { connectCache } from './cache/index';
import { loadBlocklist } from './cache/blocklist';
import { app } from './api/server';

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('Starting Meadow...');
  await testConnection();
  console.log('Database connected.');
  await connectCache();
  await loadBlocklist();

  app.listen(PORT, () => {
    console.log(`Meadow API running on http://localhost:${PORT}`);
  });
}

main().catch(console.error);