import { Pool } from 'pg';
import dotenv from 'dotenv';
import { isBoxMode } from '../mode';

dotenv.config();

/**
 * Box-mode shim.
 *
 * In box-mode (the on-prem Pi) the process has no Postgres at all —
 * filter policy comes from the cloud API, block events go back up the
 * same way. The pg.Pool is never constructed (no DATABASE_URL needed,
 * no idle TLS connections to maintain), and any code path that still
 * tries to call db.query() or db.connect() throws loudly so we catch
 * a missed refactor early instead of silently swallowing data.
 *
 * After PRs 3 & 4 land, no box-mode code path should reach this proxy.
 */
export function boxModeProxy(): Pool {
  const trap = (op: string) => () => {
    throw new Error(
      `db.${op}() called in box mode — the box never touches Postgres ` +
        `(MEADOW_MODE=box). This is a missed refactor; the call site ` +
        `should be using the cloud API instead.`,
    );
  };
  return new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'on') return () => undefined; // swallow .on('error')
        if (prop === 'end') return () => Promise.resolve();
        return trap(prop);
      },
    },
  ) as unknown as Pool;
}

/**
 * Postgres connection pool.
 *
 * Defaults below are tuned for the alpha deploy on Fly.io:
 *
 *   max=10                      Plenty for a single 1-CPU machine. The
 *                               app's per-request DB workload is
 *                               1–4 fast queries; 10 in-flight is
 *                               more than the soft request limit
 *                               (200 concurrent in fly.toml) needs.
 *
 *   min=2                       Keep two warm connections alive even
 *                               when the app is idle. Defends against
 *                               cold-start 500s on the first request
 *                               after a quiet stretch — TLS handshake
 *                               + auth to PG is ~200–800ms and we
 *                               don't want the user paying it.
 *
 *   idleTimeoutMillis=30_000    Default is 10s. Bumped so the warm
 *                               connections from `min=2` actually
 *                               survive long quiet stretches instead
 *                               of being recycled every 10s.
 *
 *   connectionTimeoutMillis=
 *     5_000                     Default is 0 = wait forever. With a
 *                               full pool that produces 30s+ hangs at
 *                               the proxy layer (e.g. the DELETE
 *                               /children "stuck on Deleting…" report
 *                               — every connection in flight, the
 *                               handler's db.connect() hangs until a
 *                               request elsewhere finishes). Better
 *                               to fail fast with a 500 the client
 *                               can retry than spin a connection.
 *
 *   query_timeout=10_000        Per-query cap. A slow query that
 *                               outlives this is killed and surfaces
 *                               as an error instead of holding a
 *                               connection out of the pool indefinitely.
 *                               10s is generous for everything we do;
 *                               legitimate transactions complete in
 *                               <100ms.
 *
 * All values are env-overridable for ops emergencies. SSL is not set
 * here; pg's `connectionString` honors `?sslmode=require` if the
 * DATABASE_URL includes it (Fly's managed Postgres does).
 */
const intEnv = (name: string, fallback: number): number => {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const db: Pool = isBoxMode()
  ? boxModeProxy()
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      max: intEnv('PGPOOL_MAX', 10),
      min: intEnv('PGPOOL_MIN', 2),
      idleTimeoutMillis: intEnv('PGPOOL_IDLE_MS', 30_000),
      connectionTimeoutMillis: intEnv('PGPOOL_CONNECT_TIMEOUT_MS', 5_000),
      query_timeout: intEnv('PGPOOL_QUERY_TIMEOUT_MS', 10_000),
    });

if (!isBoxMode()) {
  db.on('error', (err) => {
    console.error('Database connection error:', err);
  });
}

export async function testConnection() {
  if (isBoxMode()) {
    return { now: new Date(), mode: 'box' };
  }
  const client = await db.connect();
  const result = await client.query('SELECT NOW()');
  client.release();
  return result.rows[0];
}
