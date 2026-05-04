/**
 * Known DNS-over-HTTPS (DoH) and DNS-over-TLS (DoT) endpoints.
 *
 * Modern browsers (Chrome, Firefox, Edge, Brave) can be configured to use
 * DoH directly, bypassing the local DNS server. If we don't block these,
 * the kid sets their browser to "Cloudflare" or "NextDNS" in settings and
 * Meadow stops seeing their queries entirely.
 *
 * This list is the application-layer defense — block the *domains* that
 * clients use to discover and connect to DoH servers. The complete defense
 * also requires firewall rules blocking the *IPs* of these providers
 * (1.1.1.1, 8.8.8.8, etc.) because some clients hardcode IPs. That
 * firewall layer lives in the Pi deploy scripts, not here.
 *
 * Source consensus: this list is compiled from public DoH provider lists
 * (Cloudflare, Google, Mozilla, NextDNS, Quad9, AdGuard, OpenDNS, etc.)
 * and the curated public-dns/public-dns repo.
 *
 * Curated and intentional — do NOT auto-update from third-party sources.
 * If a parent legitimately wants to allow a specific provider (rare),
 * they can add it to their per-child allowlist.
 */
export const DOH_BYPASS_DOMAINS: string[] = [
  // Cloudflare
  'cloudflare-dns.com',
  'one.one.one.one',
  'mozilla.cloudflare-dns.com',
  'family.cloudflare-dns.com',
  'security.cloudflare-dns.com',
  'chrome.cloudflare-dns.com',

  // Google
  'dns.google',
  'dns.google.com',
  'dns64.dns.google',

  // Quad9
  'dns.quad9.net',
  'dns10.quad9.net',
  'dns11.quad9.net',
  'dns12.quad9.net',

  // NextDNS
  'dns.nextdns.io',

  // OpenDNS / Cisco
  'doh.opendns.com',
  'doh.familyshield.opendns.com',
  'doh.umbrella.com',

  // AdGuard
  'dns.adguard.com',
  'dns-family.adguard.com',
  'dns-unfiltered.adguard.com',
  'dns.adguard-dns.com',
  'family.adguard-dns.com',
  'unfiltered.adguard-dns.com',

  // Mullvad
  'doh.mullvad.net',
  'dns.mullvad.net',
  'adblock.doh.mullvad.net',
  'family.dns.mullvad.net',

  // CleanBrowsing
  'doh.cleanbrowsing.org',
  'doh.cleanbrowsing.org.',

  // ControlD
  'dns.controld.com',
  'freedns.controld.com',

  // LibreDNS
  'doh.libredns.gr',

  // DNS.SB
  'doh.dns.sb',

  // dns0.eu
  'dns0.eu',
  'zero.dns0.eu',
  'kids.dns0.eu',

  // Snopyta / OpenNIC / various community
  'fi.doh.dns.snopyta.org',
  'doh.dns.snopyta.org',

  // Apple Private Relay (also masks DNS)
  'mask.icloud.com',
  'mask-h2.icloud.com',

  // CIRA Canadian Shield
  'private.canadianshield.cira.ca',
  'protected.canadianshield.cira.ca',
  'family.canadianshield.cira.ca',

  // Oracle / BlahDNS
  'doh.blahdns.com',

  // BlockerDNS
  'doh.blockerdns.com',

  // CommonsHost
  'commons.host',

  // Tencent
  'doh.pub',

  // Alibaba
  'dns.alidns.com',

  // Generic catch-alls / CDN entry points used by some clients
  'doh.dns.apple.com',
];
