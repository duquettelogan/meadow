import bcrypt from 'bcrypt';

// Cost factor 12 — ~250ms per hash on modern hardware. Tunable.
const BCRYPT_ROUNDS = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, BCRYPT_ROUNDS);
}

export async function verifyPassword(
  plaintext: string,
  hash: string
): Promise<boolean> {
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/**
 * Basic password rules. Tighten over time.
 */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string') return 'password must be a string';
  if (password.length < 12) return 'password must be at least 12 characters';
  if (password.length > 200) return 'password is too long';
  return null;
}
