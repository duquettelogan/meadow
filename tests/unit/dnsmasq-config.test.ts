import { describe, it, expect } from 'vitest';
import {
  buildDnsmasqConfig,
  pickDhcpRange,
  cidrToNetmask,
} from '../../src/box/dnsmasq-config';

describe('buildDnsmasqConfig', () => {
  it('emits port=0 (DHCP-only) so it does not fight Meadow on :53', () => {
    const c = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '192.168.1.50',
      gateway_ip: '192.168.1.1',
      netmask: '255.255.255.0',
      dhcp_start: '192.168.1.100',
      dhcp_end: '192.168.1.250',
    });
    expect(c).toMatch(/^port=0$/m);
  });

  it('binds the requested interface and uses bind-interfaces', () => {
    const c = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '10.0.0.5',
      gateway_ip: '10.0.0.1',
      netmask: '255.255.255.0',
      dhcp_start: '10.0.0.100',
      dhcp_end: '10.0.0.250',
    });
    expect(c).toMatch(/^interface=eth0$/m);
    expect(c).toMatch(/^bind-interfaces$/m);
  });

  it('hands out the box as DNS server and the home router as gateway', () => {
    const c = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '192.168.86.50',
      gateway_ip: '192.168.86.1',
      netmask: '255.255.255.0',
      dhcp_start: '192.168.86.100',
      dhcp_end: '192.168.86.250',
    });
    expect(c).toMatch(/dhcp-option=option:router,192\.168\.86\.1/);
    expect(c).toMatch(/dhcp-option=option:dns-server,192\.168\.86\.50/);
  });

  it('uses 1h lease by default and respects an override', () => {
    const a = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '192.168.1.5',
      gateway_ip: '192.168.1.1',
      netmask: '255.255.255.0',
      dhcp_start: '192.168.1.100',
      dhcp_end: '192.168.1.250',
    });
    expect(a).toMatch(/dhcp-range=192\.168\.1\.100,192\.168\.1\.250,255\.255\.255\.0,1h/);

    const b = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '192.168.1.5',
      gateway_ip: '192.168.1.1',
      netmask: '255.255.255.0',
      dhcp_start: '192.168.1.100',
      dhcp_end: '192.168.1.250',
      lease_time: '6h',
    });
    expect(b).toMatch(/dhcp-range=.*?,6h/);
  });

  it('sets no-resolv + no-hosts so dnsmasq cannot fall back to upstream DNS', () => {
    const c = buildDnsmasqConfig({
      interface: 'eth0',
      box_ip: '192.168.1.5',
      gateway_ip: '192.168.1.1',
      netmask: '255.255.255.0',
      dhcp_start: '192.168.1.100',
      dhcp_end: '192.168.1.250',
    });
    expect(c).toMatch(/^no-resolv$/m);
    expect(c).toMatch(/^no-hosts$/m);
  });
});

describe('pickDhcpRange', () => {
  it('picks .100-.250 in a /24', () => {
    const r = pickDhcpRange('192.168.1.50', 24);
    expect(r).toEqual({ start: '192.168.1.100', end: '192.168.1.250' });
  });

  it('falls back to /24-style range for non-/24 (caller can override)', () => {
    const r = pickDhcpRange('10.0.5.10', 16);
    expect(r.start.endsWith('.100')).toBe(true);
    expect(r.end.endsWith('.250')).toBe(true);
  });
});

describe('cidrToNetmask', () => {
  it('/24 → 255.255.255.0', () => {
    expect(cidrToNetmask(24)).toBe('255.255.255.0');
  });
  it('/16 → 255.255.0.0', () => {
    expect(cidrToNetmask(16)).toBe('255.255.0.0');
  });
  it('/8 → 255.0.0.0', () => {
    expect(cidrToNetmask(8)).toBe('255.0.0.0');
  });
  it('/32 → 255.255.255.255', () => {
    expect(cidrToNetmask(32)).toBe('255.255.255.255');
  });
  it('/0 → 0.0.0.0', () => {
    expect(cidrToNetmask(0)).toBe('0.0.0.0');
  });
  it('throws on invalid cidr', () => {
    expect(() => cidrToNetmask(33)).toThrow();
    expect(() => cidrToNetmask(-1)).toThrow();
  });
});
