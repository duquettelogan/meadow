/**
 * Process-mode detection.
 *
 * The same Meadow codebase runs in two distinct postures:
 *
 *   api  — the cloud API server. Talks to Postgres and Redis. Serves
 *          the dashboard's REST surface, the box-pair flow, and the
 *          DoH endpoint. Default mode.
 *
 *   box  — the on-prem Pi box. Has NO database. Serves UDP DNS on the
 *          LAN, fetches policy from the cloud API on a timer, batches
 *          block events back up. Reads its identity from box.env.
 *
 * Resolution order:
 *   1. process.env.MEADOW_MODE if set to 'api' or 'box' — wins.
 *   2. If box.env exists on disk → 'box'.
 *   3. Default → 'api'.
 *
 * The check is read-once on first call and cached. Tests that need to
 * flip mode mid-process should reset via _resetModeForTests().
 */

import * as fs from 'fs';

export type Mode = 'api' | 'box';

const BOX_ENV_FILE = process.env.BOX_ENV_FILE || '/etc/meadow/box.env';

let cached: Mode | null = null;

export function getMode(): Mode {
  if (cached) return cached;
  cached = resolve();
  return cached;
}

function resolve(): Mode {
  const explicit = process.env.MEADOW_MODE?.trim().toLowerCase();
  if (explicit === 'api' || explicit === 'box') return explicit;
  if (fs.existsSync(BOX_ENV_FILE)) return 'box';
  return 'api';
}

export function isBoxMode(): boolean {
  return getMode() === 'box';
}

export function isApiMode(): boolean {
  return getMode() === 'api';
}

/**
 * Test helper. Don't call in production.
 */
export function _resetModeForTests(): void {
  cached = null;
}
