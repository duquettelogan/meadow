import express from 'express';
import { db } from '../db/connection';

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'meadow-api' });
});

app.post('/api/v1/families', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  try {
    const result = await db.query(
      `INSERT INTO families (email)
       VALUES ($1)
       RETURNING id, email, created_at`,
      [email]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'email already exists' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

app.get('/api/v1/families/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await db.query(
      `SELECT id, email, created_at FROM families WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: 'family not found' });
      return;
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

export { app };