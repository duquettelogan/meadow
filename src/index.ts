import { testConnection } from './db/connection';
import { app } from './api/server';

const PORT = process.env.PORT || 3000;

async function main() {
  console.log('Starting Meadow...');
  await testConnection();
  console.log('Database connected.');

  app.listen(PORT, () => {
    console.log(`Meadow API running on http://localhost:${PORT}`);
  });
}

main().catch(console.error);