import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

db.on('error', (err) => {
  console.error('Database connection error:', err);
});

export async function testConnection() {
  const client = await db.connect();
  const result = await client.query('SELECT NOW()');
  client.release();
  return result.rows[0];
}