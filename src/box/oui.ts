/**
 * OUI lookup — first 24 bits of a MAC → vendor name.
 *
 * Backed by data/oui.txt in the repo. Format is the official IEEE
 * oui.txt format so operators can swap in the full list without
 * touching this code:
 *
 *   curl -fsSL https://standards-oui.ieee.org/oui/oui.txt > data/oui.txt
 *
 * Loaded lazily on first lookup, cached for the lifetime of the
 * process. The shipped subset is small (a few KB) but the full IEEE
 * file is ~4MB / ~30k entries — still trivial to load.
 */

import * as fs from 'fs';
import * as path from 'path';

const DEFAULT_OUI_PATH = path.join(__dirname, '..', '..', 'data', 'oui.txt');
const OUI_PATH = process.env.OUI_FILE || DEFAULT_OUI_PATH;

let ouiMap: Map<string, string> | null = null;

function loadOui(): Map<string, string> {
  if (ouiMap) return ouiMap;
  ouiMap = new Map();

  let raw = '';
  try {
    raw = fs.readFileSync(OUI_PATH, 'utf-8');
  } catch (err) {
    console.warn(`[oui] failed to read ${OUI_PATH}:`, err);
    return ouiMap;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // IEEE oui.txt line:  AA-BB-CC   (hex)    Vendor Name
    const m = trimmed.match(
      /^([0-9A-Fa-f]{2})-([0-9A-Fa-f]{2})-([0-9A-Fa-f]{2})\s+\(hex\)\s+(.+)$/,
    );
    if (m) {
      const prefix = `${m[1]}${m[2]}${m[3]}`.toUpperCase();
      ouiMap.set(prefix, m[4].trim());
      continue;
    }

    // Loose fallback for the simpler format in the shipped file's
    // historical comments (in case operators write their own additions):
    //   AABBCC Vendor Name
    const loose = trimmed.match(/^([0-9A-Fa-f]{6})\s+(.+)$/);
    if (loose) {
      ouiMap.set(loose[1].toUpperCase(), loose[2].trim());
    }
  }

  return ouiMap;
}

/**
 * Returns the manufacturer for a MAC's OUI, or undefined if unknown.
 * Accepts MAC in any of: aa:bb:cc:dd:ee:ff, aa-bb-cc-dd-ee-ff,
 * aabbccddeeff (case-insensitive).
 */
export function lookupOui(mac: string): string | undefined {
  const stripped = mac.replace(/[-:]/g, '').toUpperCase();
  if (stripped.length < 6) return undefined;
  const prefix = stripped.slice(0, 6);
  return loadOui().get(prefix);
}

/**
 * Test helper — clear the cache so a test can swap OUI_FILE and
 * re-load.
 */
export function _resetOuiCacheForTests(): void {
  ouiMap = null;
}
