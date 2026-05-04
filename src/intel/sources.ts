/**
 * Threat intelligence feed sources.
 *
 * Each source maps to a category. We pull these on a schedule (see updater.ts)
 * and store them in Redis under separate keys so the resolver can identify
 * which category a block belongs to.
 *
 * All sources are public, free, and parse as either:
 *  - "hosts" format: lines of "0.0.0.0 domain.tld"
 *  - "domains" format: one domain per line
 *
 * Adding new sources: keep the list short and high-signal. Every new feed
 * adds maintenance burden and false-positive risk. Trust StevenBlack and
 * OISD before random GitHub gists.
 */
export type FeedFormat = 'hosts' | 'domains';

export interface IntelSource {
  name: string;
  category: string;
  url: string;
  format: FeedFormat;
}

export const INTEL_SOURCES: IntelSource[] = [
  // Adult content — StevenBlack porn sublist
  {
    name: 'stevenblack-porn',
    category: 'adult',
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts',
    format: 'hosts',
  },
  // Phishing — public phishing domains feed
  {
    name: 'phishing-army',
    category: 'phishing',
    url: 'https://phishing.army/download/phishing_army_blocklist_extended.txt',
    format: 'domains',
  },
  // Malware — URLhaus daily host file
  {
    name: 'urlhaus-malware',
    category: 'malware',
    url: 'https://urlhaus.abuse.ch/downloads/hostfile/',
    format: 'hosts',
  },
];

/**
 * How often to refresh feeds, in minutes. 6h default is a balance — fast
 * enough that new threats land within hours, slow enough not to hammer
 * upstream sources.
 */
export const REFRESH_INTERVAL_MINUTES = 360;
