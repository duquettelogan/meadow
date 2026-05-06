import * as crypto from 'crypto';

/**
 * Pairing code generation — box-originated.
 *
 * 8-digit code formatted XXXX-XXXX. 100M code space; uniqueness across
 * concurrent unclaimed boxes is enforced by the server's UNIQUE
 * constraint on pairing_codes.code. The box retries with a fresh code
 * on collision.
 *
 * Uniform distribution via crypto.randomInt — biased generation would
 * shrink the practical entropy and make brute force easier.
 */
export function generatePairingCode(): string {
  const n = crypto.randomInt(0, 100_000_000);
  const padded = n.toString().padStart(8, '0');
  return `${padded.slice(0, 4)}-${padded.slice(4)}`;
}

/**
 * Accept "1234-5678" or "12345678" and return the canonical
 * "1234-5678" form. Returns null if the input isn't 8 digits.
 */
export function normalizePairingCode(input: string): string | null {
  const digits = String(input).replace(/\D/g, '');
  if (digits.length !== 8) return null;
  return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/**
 * Returns true if the input matches XXXX-XXXX or XXXXXXXX (8 digits,
 * optional dash).
 */
export function isValidPairingCode(input: string): boolean {
  return /^\d{4}-?\d{4}$/.test(String(input));
}
