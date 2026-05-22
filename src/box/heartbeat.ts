/**
 * Box heartbeat.
 *
 * Posts a health snapshot to the API every HEARTBEAT_INTERVAL_MS so the
 * parent dashboard can show an accurate "last seen" + uptime + free
 * memory + blocklist freshness. Privacy posture: no per-query data,
 * no domains, no counts of any specific category — just the box's own
 * vital signs.
 *
 * Failure handling:
 *   - Network errors are logged and swallowed. Heartbeat must NEVER
 *     interfere with DNS resolution.
 *   - The interval keeps firing on its own cadence; missed beats just
 *     show up as stale `last_seen` in the dashboard.
 *
 * Auth: bearer with the api_key persisted to state.json by bootstrap.
 * If the box isn't paired (no api_key) the heartbeat is a no-op.
 */

import * as os from 'os';
import { getBoxContext } from './context';
import { getCategorySize } from '../cache/blocklist';
import { CATEGORIES } from '../cache/blocklist';
import { reportAuthFailure, reportAuthSuccess } from './repair';

const API_URL = process.env.API_URL || process.env.MEADOW_API_URL || 'http://localhost:3000';
const HEARTBEAT_INTERVAL_MS = parseInt(
  process.env.HEARTBEAT_INTERVAL_MS ?? String(5 * 60 * 1000),
  10,
);
const BOX_VERSION = process.env.BOX_VERSION || '1.0.0';
// 5s upper bound — we never want a stuck POST to leak into the next tick.
const REQUEST_TIMEOUT_MS = 5000;

let timer: NodeJS.Timeout | null = null;
let inFlight = false;

export async function sendHeartbeat(): Promise<boolean> {
  const ctx = getBoxContext();
  if (!ctx?.api_key) return false;

  const payload = await collectSnapshot();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const res = await fetch(`${API_URL}/api/v1/devices/heartbeat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ctx.api_key}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 401) {
      // Permanent-credential signal — feed the shared repair counter
      // so two consecutive 401s (across heartbeat / policy-sync /
      // block-reporter) self-trigger a re-pair instead of looping
      // forever on a dead api_key. See src/box/repair.ts.
      reportAuthFailure('heartbeat');
      return false;
    }
    if (!res.ok) {
      console.error(`[heartbeat] API responded ${res.status}`);
      return false;
    }
    reportAuthSuccess();
    return true;
  } catch (err) {
    // Don't include the error object — fetch errors can include the URL,
    // which leaks the API host into journald. Keep it generic.
    console.error('[heartbeat] post failed (will retry on next tick)');
    return false;
  }
}

async function collectSnapshot() {
  const sizes: Record<string, number> = {};
  for (const cat of CATEGORIES) {
    try {
      sizes[cat] = await getCategorySize(cat);
    } catch {
      sizes[cat] = -1; // sentinel: redis unreachable
    }
  }

  return {
    ts: Math.floor(Date.now() / 1000),
    uptime_seconds: Math.floor(process.uptime()),
    free_memory_mb: Math.floor(os.freemem() / (1024 * 1024)),
    blocklist_versions: sizes,
    box_version: BOX_VERSION,
  };
}

export function startHeartbeat(): void {
  if (timer) return;
  if (process.env.DISABLE_HEARTBEAT === '1') {
    console.log('[heartbeat] disabled (DISABLE_HEARTBEAT=1)');
    return;
  }
  if (HEARTBEAT_INTERVAL_MS === 0) {
    console.log('[heartbeat] disabled (HEARTBEAT_INTERVAL_MS=0)');
    return;
  }

  // Initial beat after a short delay so DNS + intel get to settle first.
  setTimeout(() => {
    if (inFlight) return;
    inFlight = true;
    sendHeartbeat().finally(() => {
      inFlight = false;
    });
  }, 5000);

  timer = setInterval(() => {
    if (inFlight) return; // skip if previous is still hung up
    inFlight = true;
    sendHeartbeat().finally(() => {
      inFlight = false;
    });
  }, HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(
    `[heartbeat] started — beating every ${Math.floor(HEARTBEAT_INTERVAL_MS / 1000)}s`,
  );
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
