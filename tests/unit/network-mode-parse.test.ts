import { describe, it, expect } from 'vitest';
import { parseSubnet } from '../../src/box/network-mode';

const ADDR_OUT = `2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 qdisc fq_codel state UP group default qlen 1000
    link/ether dc:a6:32:01:02:03 brd ff:ff:ff:ff:ff:ff
    inet 192.168.86.50/24 brd 192.168.86.255 scope global dynamic noprefixroute eth0
       valid_lft 86391sec preferred_lft 86391sec
`;

const ROUTE_OUT = `default via 192.168.86.1 dev eth0 proto dhcp src 192.168.86.50 metric 100
192.168.86.0/24 dev eth0 proto kernel scope link src 192.168.86.50 metric 100
`;

describe('parseSubnet', () => {
  it('extracts box IP, CIDR, netmask, and gateway from real-shaped ip(8) output', () => {
    const s = parseSubnet(ADDR_OUT, ROUTE_OUT);
    expect(s).not.toBeNull();
    expect(s!.box_ip).toBe('192.168.86.50');
    expect(s!.cidr).toBe(24);
    expect(s!.netmask).toBe('255.255.255.0');
    expect(s!.gateway_ip).toBe('192.168.86.1');
  });

  it('returns null when there is no inet line', () => {
    expect(parseSubnet('2: eth0: ... down\n', ROUTE_OUT)).toBeNull();
  });

  it('returns null when there is no default route', () => {
    expect(parseSubnet(ADDR_OUT, '192.168.86.0/24 dev eth0 ...\n')).toBeNull();
  });

  it('handles /16 networks', () => {
    const addr = `2: eth0: ...
    inet 10.0.5.50/16 brd 10.0.255.255 scope global eth0
`;
    const route = `default via 10.0.0.1 dev eth0\n`;
    const s = parseSubnet(addr, route);
    expect(s!.cidr).toBe(16);
    expect(s!.netmask).toBe('255.255.0.0');
  });
});
