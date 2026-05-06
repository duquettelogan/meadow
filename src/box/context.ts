/**
 * Box runtime context.
 *
 * On startup, reads /etc/meadow/state.json (written by the bootstrap
 * script) and resolves the box's device_id to the family it's paired
 * to + the family's Household child profile id.
 *
 * In v1, DNS resolution is family-scoped (not per-child), so the
 * resolver only needs the family's Household policy. The Household
 * child id is pre-resolved here and used for counter attribution on
 * the UDP path so we don't have to JOIN every blocked query.
 *
 * The api_key is exposed alongside the IDs because the heartbeat +
 * discovery modules need it to authenticate POSTs back to the API.
 * It is NEVER logged or returned outside the box process.
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
  family_id: string;
  household_child_id: string | null;
  api_key: string | null;
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

  // Resolve device → family → Household child in one query. Household
  // is created at signup (and back-filled by migration 008 for older
  // families) so the LEFT JOIN should always hit, but we tolerate
  // null household_child_id and skip counter writes if so.
  try {
    const result = await db.query(
      `SELECT d.family_id, hh.id AS household_child_id
       FROM devices d
       LEFT JOIN child_profiles hh
         ON hh.family_id = d.family_id AND hh.is_household = true
       WHERE d.id = $1`,
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
      family_id: result.rows[0].family_id,
      household_child_id: result.rows[0].household_child_id ?? null,
      api_key: state.api_key ?? null,
    };
    console.log(
      `[box] context loaded: device=${cached.device_id} family=${cached.family_id} household=${cached.household_child_id ?? 'missing'}`,
    );
    return cached;
  } catch (err) {
    console.error('[box] failed to resolve device → family:', err);
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
