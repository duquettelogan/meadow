/**
 * Box runtime context.
 *
 * On startup, reads /etc/meadow/state.json (written by the bootstrap
 * script) and resolves the box's device_id to a child_profile_id. The
 * UDP DNS server uses this to attribute block counts — every query
 * served by the box's network-level DNS attributes to the single child
 * the box is paired to.
 *
 * v1 assumption: one box → one child profile. Multi-child households
 * use device-level resolve (per-device API keys) instead. If we add
 * box-level multi-child later, this module becomes a per-source-IP
 * lookup, not a single cached profile.
 */

import * as fs from 'fs';
import { db } from '../db/connection';

const STATE_FILE = process.env.STATE_FILE || '/etc/meadow/state.json';

interface PersistedState {
  hardware_id: string;
  api_key?: string;
  device_id?: string;
}

export interface BoxContext {
  device_id: string;
  child_profile_id: string | null;
}

let cached: BoxContext | null = null;

/**
 * Load the box context from disk + DB. Idempotent — safe to call
 * multiple times. Returns null if the box is not yet paired or the
 * state file is missing (dev mode, fresh install before bootstrap
 * has run, etc).
 */
export async function loadBoxContext(): Promise<BoxContext | null> {
  if (cached) return cached;

  if (!fs.existsSync(STATE_FILE)) {
    console.log(`[box] no state file at ${STATE_FILE} — running unpaired`);
    return null;
  }

  let state: PersistedState;
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) {
    console.error(`[box] failed to parse ${STATE_FILE}:`, err);
    return null;
  }

  if (!state.device_id) {
    console.log('[box] state file has no device_id — not paired yet');
    return null;
  }

  // Resolve the device_id to its child_profile_id. The box's device row
  // is created during pairing, so this should always exist for a paired
  // box. If it doesn't, something blew up — log loudly and run unpaired
  // so the DNS path still works (just without counters).
  try {
    const result = await db.query(
      'SELECT child_profile_id FROM devices WHERE id = $1',
      [state.device_id],
    );
    if (result.rows.length === 0) {
      console.error(
        `[box] device ${state.device_id} not found in DB — pairing may have been revoked`,
      );
      return null;
    }
    cached = {
      device_id: state.device_id,
      child_profile_id: result.rows[0].child_profile_id ?? null,
    };
    console.log(
      `[box] context loaded: device=${cached.device_id} child=${cached.child_profile_id ?? 'unassigned'}`,
    );
    return cached;
  } catch (err) {
    console.error('[box] failed to resolve device → child:', err);
    return null;
  }
}

/**
 * Synchronous accessor for the cached context. Returns null if
 * loadBoxContext() hasn't run yet or pairing wasn't found.
 */
export function getBoxContext(): BoxContext | null {
  return cached;
}

/**
 * Test helper. Don't call in production.
 */
export function _resetBoxContextForTests(): void {
  cached = null;
}
