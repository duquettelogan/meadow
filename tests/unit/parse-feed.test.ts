import { describe, it, expect } from 'vitest';
import { parseFeed } from '../../src/intel/updater';

describe('parseFeed', () => {
  describe('hosts format', () => {
    it('parses 0.0.0.0 lines', () => {
      const text = `
        # comment
        0.0.0.0 evil.com
        0.0.0.0 bad.example
      `;
      expect(parseFeed(text, 'hosts')).toEqual(['evil.com', 'bad.example']);
    });

    it('also accepts 127.0.0.1', () => {
      const text = '127.0.0.1 also-bad.com';
      expect(parseFeed(text, 'hosts')).toEqual(['also-bad.com']);
    });

    it('skips other IPs', () => {
      const text = '8.8.8.8 google-dns.com';
      expect(parseFeed(text, 'hosts')).toEqual([]);
    });

    it('skips comments and blank lines', () => {
      const text = `
# header
! also a comment
0.0.0.0 evil.com

# trailing
`;
      expect(parseFeed(text, 'hosts')).toEqual(['evil.com']);
    });

    it('lowercases domains', () => {
      expect(parseFeed('0.0.0.0 EVIL.COM', 'hosts')).toEqual(['evil.com']);
    });

    it('skips localhost and broadcasthost noise', () => {
      const text = `
        0.0.0.0 localhost
        0.0.0.0 broadcasthost
        0.0.0.0 evil.com
      `;
      expect(parseFeed(text, 'hosts')).toEqual(['evil.com']);
    });

    it('rejects malformed domains', () => {
      const text = `
        0.0.0.0 192.168.1.1
        0.0.0.0 has spaces
        0.0.0.0 nodot
        0.0.0.0 valid.com
      `;
      // "has" gets parsed as a single label "has", "nodot" has no dot.
      expect(parseFeed(text, 'hosts')).toEqual(['valid.com']);
    });
  });

  describe('domains format', () => {
    it('parses one domain per line', () => {
      const text = `
        evil.com
        bad.example
        also-bad.org
      `;
      expect(parseFeed(text, 'domains')).toEqual([
        'evil.com',
        'bad.example',
        'also-bad.org',
      ]);
    });

    it('takes first whitespace-separated token', () => {
      const text = 'evil.com extra junk here';
      expect(parseFeed(text, 'domains')).toEqual(['evil.com']);
    });

    it('skips comments', () => {
      const text = `
        # this is a comment
        evil.com
      `;
      expect(parseFeed(text, 'domains')).toEqual(['evil.com']);
    });
  });
});
