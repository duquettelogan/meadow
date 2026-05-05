/**
 * Crisis floor.
 *
 * A hard, non-negotiable allowlist of crisis-resource domains. These
 * domains are NEVER blocked, NEVER logged, NEVER counted, and NEVER
 * surfaced in the parent dashboard. A teen reaching out to 988 must
 * have absolute confidence that the visit produces no trace inside
 * Meadow.
 *
 * Rules of engagement:
 *   - This list takes precedence over EVERY other rule, including
 *     parent block lists. Parents cannot override the floor.
 *   - Subdomains of these roots are also exempt (api.988lifeline.org,
 *     m.thehotline.org, etc).
 *   - Adding to this list is a values decision, not a feature decision.
 *     Don't add a domain just because it's "kinda related" — every
 *     entry here is a domain we are willing to defend keeping
 *     unblockable for the rest of the product's life.
 *
 * v1 list is US-focused. International expansion will need country-
 * specific equivalents (Samaritans UK, Lifeline Australia, etc).
 */

const CRISIS_ROOTS = [
  // Suicide & general crisis
  '988lifeline.org',
  'crisistextline.org',
  'veteranscrisisline.net',

  // LGBTQ+ youth
  'thetrevorproject.org',

  // Domestic violence
  'thehotline.org',
  'loveisrespect.org',

  // Sexual assault
  'rainn.org',

  // Child abuse
  'childhelp.org',

  // Broader mental health (gov + nonprofit, intentionally narrow)
  'nami.org',
  'samhsa.gov',
] as const;

const ROOT_SET = new Set<string>(CRISIS_ROOTS);

/**
 * Returns true if the given domain is on the crisis floor or is a
 * subdomain of one. Domain comparison is case-insensitive and
 * tolerates a trailing dot (DNS canonical form).
 */
export function isCrisisDomain(domain: string): boolean {
  if (!domain) return false;
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (ROOT_SET.has(normalized)) return true;
  for (const root of CRISIS_ROOTS) {
    if (normalized.endsWith('.' + root)) return true;
  }
  return false;
}

/**
 * Exposed for tests / dashboard "what's on the floor" pages. Do NOT
 * log the result of this from inside a request path — it's a list of
 * sensitive resources and shouldn't appear in request logs.
 */
export function listCrisisDomains(): readonly string[] {
  return CRISIS_ROOTS;
}
