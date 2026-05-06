import { describe, it, expect } from 'vitest';
import { _renderForTests } from '../../src/box/web';

describe('pairing web page', () => {
  it('renders the pending state with the code prominently', () => {
    const html = _renderForTests('1234-5678', 'pending');
    expect(html).toContain('1234-5678');
    expect(html).toMatch(/pair this meadow box/i);
    // Auto-refresh every 5s while pending so the parent sees the
    // success transition without manually reloading.
    expect(html).toMatch(/<meta\s+http-equiv="refresh"\s+content="5"/i);
  });

  it('renders the paired state without exposing the code', () => {
    const html = _renderForTests('1234-5678', 'paired');
    expect(html).toMatch(/paired successfully/i);
    expect(html).not.toContain('1234-5678');
    // No need to refresh once paired.
    expect(html).not.toMatch(/<meta\s+http-equiv="refresh"/i);
  });

  it('escapes hostile input in the code field', () => {
    const html = _renderForTests('<script>alert(1)</script>', 'pending');
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
  });
});
