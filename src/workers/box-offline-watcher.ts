/**
 * Box offline alert worker.
 *
 * Cron-style background loop. Every hour (configurable via
 * OFFLINE_ALERT_INTERVAL_MS), find every paired device that:
 *   - has at least one non-revoked api_key (i.e. is a paired Meadow
 *     box, not a synthetic discovered/network device — those have a
 *     `disc_…` device_token and never get an api_key)
 *   - has not heartbeated in >OFFLINE_THRESHOLD_HOURS (default 24h)
 *   - has not already been alerted for this silent stretch
 *     (offline_alert_sent_at IS NULL)
 *
 * For each match, email the family's primary parent (the founding
 * parent's email is denormalized on families.email at signup time)
 * and stamp offline_alert_sent_at = NOW().
 *
 * Reset path: the heartbeat handler in src/api/server.ts clears
 * offline_alert_sent_at = NULL whenever a box checks in — so the
 * next time the box goes silent for >24h, it gets another alert.
 *
 * Disabling: OFFLINE_ALERTS_DISABLED=1 (set in tests/setup.ts).
 *
 * Privacy posture: we email "your box looks offline" + a link to the
 * dashboard's box-health page. We do NOT include block stats,
 * filter-policy state, or any data about specific devices.
 */

import { db } from '../db/connection';
import { sendBoxOfflineEmail } from '../email';

const HOUR_MS = 60 * 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.OFFLINE_ALERT_INTERVAL_MS ?? String(HOUR_MS),
  10,
);
const THRESHOLD_HOURS = parseInt(
  process.env.OFFLINE_THRESHOLD_HOURS ?? '24',
  10,
);

let timer: NodeJS.Timeout | null = null;

export function startOfflineAlertWatcher(): void {
  if (timer) return;
  if (process.env.OFFLINE_ALERTS_DISABLED === '1') {
    console.log('[offline-alerts] disabled (OFFLINE_ALERTS_DISABLED=1)');
    return;
  }

  // Schedule before the first run so a slow tick doesn't block startup.
  timer = setInterval(() => {
    void runOfflineAlertCheckOnce().catch((err) => {
      console.error('[offline-alerts] tick failed:', (err as Error).message);
    });
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  // Initial run after a short delay so other workers (heartbeat,
  // discover) get to log first and we don't all flush at t=0.
  setTimeout(() => {
    void runOfflineAlertCheckOnce().catch(() => {});
  }, 10_000).unref?.();

  console.log(
    `[offline-alerts] started — interval=${Math.floor(INTERVAL_MS / 60_000)}min, threshold=${THRESHOLD_HOURS}h`,
  );
}

export function stopOfflineAlertWatcher(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Single sweep of the silent-box check. Exported so tests can drive it
 * deterministically without touching setInterval.
 *
 * Returns the number of boxes alerted this sweep — useful for tests.
 */
export async function runOfflineAlertCheckOnce(): Promise<number> {
  // The query is family-scoped via families.email so we can email the
  // primary parent in a single round trip.
  //
  // Boxes-only filter: EXISTS (api_keys with this device, not revoked).
  // Synthetic disc_<hex> rows on discovered devices have no api_keys.
  const result = await db.query(
    `SELECT d.id AS device_id,
            d.last_seen,
            f.email AS primary_email
       FROM devices d
       JOIN families f ON f.id = d.family_id
       WHERE d.last_seen IS NOT NULL
         AND d.last_seen < NOW() - INTERVAL '${THRESHOLD_HOURS} hours'
         AND d.offline_alert_sent_at IS NULL
         AND EXISTS (
           SELECT 1 FROM api_keys k
           WHERE k.device_id = d.id AND k.revoked_at IS NULL
         )`,
  );

  let alerted = 0;
  for (const row of result.rows) {
    try {
      await sendBoxOfflineEmail(row.primary_email, {
        lastSeenIso: row.last_seen?.toISOString?.() ?? null,
      });
      // Stamp regardless of email-send outcome — sendBoxOfflineEmail
      // already swallows provider errors. Stamping ensures we don't
      // re-email on every tick if the provider is intermittently down.
      await db.query(
        'UPDATE devices SET offline_alert_sent_at = NOW() WHERE id = $1',
        [row.device_id],
      );
      alerted++;
    } catch (err) {
      console.error(
        `[offline-alerts] failed for device=${row.device_id}:`,
        (err as Error).message,
      );
    }
  }
  return alerted;
}
