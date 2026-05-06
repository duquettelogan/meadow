import { describe, it, expect } from 'vitest';
import { buildDhcpDiscover } from '../../src/box/dhcp-detect';

describe('buildDhcpDiscover', () => {
  const xid = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const mac = Buffer.from([0x02, 0xaa, 0xbb, 0xcc, 0xdd, 0xee]);

  it('produces a valid BOOTREQUEST with magic cookie + DHCPDISCOVER option', () => {
    const pkt = buildDhcpDiscover(xid, mac);
    expect(pkt.length).toBeGreaterThanOrEqual(244);
    // op = BOOTREQUEST
    expect(pkt[0]).toBe(1);
    // htype = ethernet
    expect(pkt[1]).toBe(1);
    // hlen = 6 (MAC length)
    expect(pkt[2]).toBe(6);
    // xid at offset 4-7
    expect(pkt.subarray(4, 8).equals(xid)).toBe(true);
    // chaddr at offset 28-33 (first 6 bytes — MAC)
    expect(pkt.subarray(28, 34).equals(mac)).toBe(true);
    // Magic cookie at 236-239
    expect(pkt[236]).toBe(99);
    expect(pkt[237]).toBe(130);
    expect(pkt[238]).toBe(83);
    expect(pkt[239]).toBe(99);
    // Option 53 length 1 value 1 (DISCOVER) at 240-242
    expect(pkt[240]).toBe(53);
    expect(pkt[241]).toBe(1);
    expect(pkt[242]).toBe(1);
    // Option 255 (end) at 243
    expect(pkt[243]).toBe(0xff);
  });

  it('zeros all the BOOTP address fields (we are pretending to be a fresh client)', () => {
    const pkt = buildDhcpDiscover(xid, mac);
    // ciaddr (12-15), yiaddr (16-19), siaddr (20-23), giaddr (24-27)
    for (let i = 12; i < 28; i++) expect(pkt[i]).toBe(0);
  });
});
