import { describe, it, expect } from 'vitest';
import { parseDhcpOption12, isValidMac } from '../../src/box/discover';

/**
 * Build a minimal-but-valid DHCP packet. We only care about chaddr +
 * option 12 here — the rest of the BOOTP fields are zeros, which is
 * fine for our parser.
 */
function buildDhcpPacket(opts: {
  chaddr: string; // "aa:bb:cc:dd:ee:ff"
  hostname?: string;
}): Buffer {
  const buf = Buffer.alloc(300, 0);

  // BOOTP header bytes 0..27 = 0 — fine.

  // chaddr at offset 28, 16 bytes total. Only first 6 are MAC.
  const macBytes = opts.chaddr.split(':').map((h) => parseInt(h, 16));
  for (let i = 0; i < 6; i++) buf[28 + i] = macBytes[i];

  // BOOTP fields 44..235 = 0 — fine.

  // Magic cookie at offset 236-239: 99, 130, 83, 99
  buf[236] = 99;
  buf[237] = 130;
  buf[238] = 83;
  buf[239] = 99;

  let i = 240;

  // Option 12 (Host Name)
  if (opts.hostname) {
    const name = Buffer.from(opts.hostname, 'utf-8');
    buf[i++] = 12;
    buf[i++] = name.length;
    name.copy(buf, i);
    i += name.length;
  }

  // End option
  buf[i++] = 0xff;

  return buf.subarray(0, Math.max(i, 240));
}

describe('parseDhcpOption12', () => {
  it('returns the hostname when option 12 is present', () => {
    const pkt = buildDhcpPacket({
      chaddr: 'aa:bb:cc:dd:ee:ff',
      hostname: 'living-room-tv',
    });
    expect(parseDhcpOption12(pkt)).toBe('living-room-tv');
  });

  it('returns undefined when option 12 is absent', () => {
    const pkt = buildDhcpPacket({ chaddr: 'aa:bb:cc:dd:ee:ff' });
    expect(parseDhcpOption12(pkt)).toBeUndefined();
  });

  it('returns undefined for too-short packets', () => {
    expect(parseDhcpOption12(Buffer.alloc(50))).toBeUndefined();
  });

  it('returns undefined when the magic cookie is missing', () => {
    const buf = Buffer.alloc(300, 0);
    // No magic cookie — parser should bail.
    expect(parseDhcpOption12(buf)).toBeUndefined();
  });

  it('handles hostnames with non-ASCII chars', () => {
    const pkt = buildDhcpPacket({
      chaddr: 'aa:bb:cc:dd:ee:ff',
      hostname: 'küche-echo',
    });
    expect(parseDhcpOption12(pkt)).toBe('küche-echo');
  });
});

describe('isValidMac', () => {
  it('accepts canonical and dash forms', () => {
    expect(isValidMac('aa:bb:cc:dd:ee:ff')).toBe(true);
    expect(isValidMac('AA:BB:CC:DD:EE:FF')).toBe(true);
    expect(isValidMac('aa-bb-cc-dd-ee-ff')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidMac('not-a-mac')).toBe(false);
    expect(isValidMac('aa:bb:cc:dd:ee')).toBe(false); // too short
    expect(isValidMac('aa:bb:cc:dd:ee:ff:00')).toBe(false); // too long
    expect(isValidMac('aabb.ccdd.eeff')).toBe(false); // cisco form unsupported
    expect(isValidMac('')).toBe(false);
  });
});
