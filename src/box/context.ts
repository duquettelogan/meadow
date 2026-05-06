/**
 * Box runtime context.
 *
 * v1.5: reads /etc/meadow/box.env (key=value, written by bootstrap.ts
 * after the box-originated pairing flow completes) instead of the
 * older /etc/meadow/state.json. systemd EnvironmentFile= can also
 * source this directly, which simplifies process.env wiring on the box.
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

const BOX_ENV_FILE = process.env.BOX_ENV_FILE || '/etc/meadow/box.env';
// Back-compat: if box.env doesn't exist but the v0 state.json does,
// fall back to that. v0 deployments were never shipped to households,
// but Logan's dev boxes may still have a state.json lying around.
const LEGACY_STATE_FILE = process.env.STATE_FILE || '/etc/meadow/state.json';

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

function readBoxEnv(): PersistedState | null {
  if (!fs.existsSync(BOX_ENV_FILE)) return null;
  try {
    const out: any = {};
    for (const line of fs.readFileSync(BOX_ENV_FILE, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (key === 'MEADOW_HARDWARE_ID') out.hardware_id = value;
      if (key === 'MEADOW_API_KEY') out.api_key = value;
      if (key === 'MEADOW_DEVICE_ID') out.device_id = value;
    }
    if (!out.hardware_id) return null;
    return out as PersistedState;
  } catch (err) {
    console.error(`[box] failed to read ${BOX_ENV_FILE}:`, err);
    return null;
  }
}

function readLegacyStateJson(): PersistedState | null {
  if (!fs.existsSync(LEGACY_STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf-8'));
    if (parsed && typeof parsed.hardware_id === 'string') {
      return parsed;
    }
  } catch (err) {
    console.error(`[box] failed to parse ${LEGACY_STATE_FILE}:`, err);
  }
  return null;
}

/**
 * Load the box context from disk + DB. Idempotent — safe to call
 * multiple times. Returns null if the box is not yet paired or the
 * state files are missing (dev mode, fresh install before bootstrap
 * has run, etc).
 */
export async function loadBoxContext(): Promise<BoxContext | null> {
  if (cached) return cached;

  const state = readBoxEnv() ?? readLegacyStateJson();
  if (!state) {
    console.log(
      `[box] no state at ${BOX_ENV_FILE} (legacy: ${LEGACY_STATE_FILE}) — running unpaired`,
    );
    return null;
  }

  if (!state.device_id) {
    console.log('[box] state has no device_id — not paired yet');
    return null;
  }

  // Resolve device → family → Household child in one query.
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
