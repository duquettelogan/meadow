/**
 * Captive portal allowlist.
 *
 * Phones, laptops, and IoT devices probe these well-known URLs to detect
 * "is there real internet here?" If we sinkhole them, the device decides
 * the wifi is broken and pops "no internet connection" warnings — even
 * though the LAN is fine and the rest of the web works. iPhones in
 * particular will refuse to use the network for anything else.
 *
 * Therefore: these domains are ALWAYS allowed, regardless of category
 * blocklists or parent-side block lists. They sit between the crisis
 * floor (still highest priority) and any other filtering.
 *
 * Unlike crisis-floor.ts these are NOT privacy-sensitive — they're
 * network test hostnames. We allow them to be logged and counted as
 * normal allows; we just refuse to block them.
 *
 * Add new entries here when a new platform or device family is found
 * to break behind the filter. Match logic is identical to crisis floor:
 * exact match or subdomain.
 */

const PORTAL_ROOTS = [
  // Apple
  'captive.apple.com',
  'gsp1.apple.com',
  'www.apple.com', // some macOS versions hit this for connectivity check

  // Google / Android / ChromeOS
  'connectivitycheck.gstatic.com',
  'connectivitycheck.android.com',
  'clients3.google.com',
  'clients4.google.com',

  // Microsoft / Windows
  'www.msftconnecttest.com',
  'www.msftncsi.com',
  'dns.msftncsi.com',
  'ipv6.msftncsi.com',

  // Mozilla / Firefox
  'detectportal.firefox.com',

  // GNOME / Linux desktop
  'nmcheck.gnome.org',
  'network-test.debian.org',

  // Ubuntu
  'connectivity-check.ubuntu.com',
] as const;

const ROOT_SET = new Set<string>(PORTAL_ROOTS);

export function isCaptivePortalDomain(domain: string): boolean {
  if (!domain) return false;
  const normalized = domain.toLowerCase().replace(/\.$/, '');
  if (ROOT_SET.has(normalized)) return true;
  for (const root of PORTAL_ROOTS) {
    if (normalized.endsWith('.' + root)) return true;
  }
  return false;
}

export function listCaptivePortalDomains(): readonly string[] {
  return PORTAL_ROOTS;
}
