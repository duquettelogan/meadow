import { loadBlocklist } from '../cache/blocklist';

loadBlocklist()
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed:', err);
    process.exit(1);
  });