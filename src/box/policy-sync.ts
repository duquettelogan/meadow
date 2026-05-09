/**
 * Box-side policy sync loop.
 *
 * Every POLICY_SYNC_INTERVAL_MS (default 5 min) wake up and refresh
 * the box's filter-policy snapshot from the cloud API. Refresh writes
 * back to both the in-memory cached context AND Redis (see
 * src/box/context.ts).
 *
 * On failure: leave the cached snapshot in place and try again on the
 * next tick. The resolver keeps serving DNS with the last-known
 * policy — that's the right behavior when the API is briefly
 * unreachable (better than turning filtering off).
 *
 * Disabling: POLICY_SYNC_DISABLED=1 (set in tests).
 */

import { refreshBoxPolicy } from './context';

const FIVE_MIN = 5 * 60 * 1000;

const INTERVAL_MS = parseInt(
  process.env.POLICY_SYNC_INTERVAL_MS ?? String(FIVE_MIN),
  10,
);

let timer: NodeJS.Timeout | null = null;

export function startPolicySync(): void {
  if (timer) return;
  if (process.env.POLICY_SYNC_DISABLED === '1') {
    console.log('[policy-sync] disabled (POLICY_SYNC_DISABLED=1)');
    return;
  }
  timer = setInterval(() => {
    void refreshBoxPolicy()
      .then((ok) => {
        if (!ok) {
          console.warn(
            '[policy-sync] tick failed — keeping previous cached policy',
          );
        }
      })
      .catch((err) => {
        console.error('[policy-sync] tick threw:', (err as Error).message);
      });
  }, INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log(
    `[policy-sync] started — interval=${Math.floor(INTERVAL_MS / 60_000)}min`,
  );
}

export function stopPolicySync(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
