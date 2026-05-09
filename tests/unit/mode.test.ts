import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { _resetModeForTests, getMode, isBoxMode, isApiMode } from '../../src/mode';
import { boxModeProxy } from '../../src/db/connection';

const ORIGINAL = process.env.MEADOW_MODE;

beforeEach(() => {
  _resetModeForTests();
  delete process.env.MEADOW_MODE;
});

afterEach(() => {
  if (ORIGINAL === undefined) {
    delete process.env.MEADOW_MODE;
  } else {
    process.env.MEADOW_MODE = ORIGINAL;
  }
  _resetModeForTests();
});

describe('mode resolution', () => {
  it('defaults to api when nothing is set', () => {
    expect(getMode()).toBe('api');
    expect(isApiMode()).toBe(true);
    expect(isBoxMode()).toBe(false);
  });

  it('respects MEADOW_MODE=box', () => {
    process.env.MEADOW_MODE = 'box';
    _resetModeForTests();
    expect(getMode()).toBe('box');
    expect(isBoxMode()).toBe(true);
  });

  it('respects MEADOW_MODE=api', () => {
    process.env.MEADOW_MODE = 'api';
    _resetModeForTests();
    expect(getMode()).toBe('api');
  });

  it('ignores garbage MEADOW_MODE values and defaults to api', () => {
    process.env.MEADOW_MODE = 'garbage';
    _resetModeForTests();
    expect(getMode()).toBe('api');
  });

  it('caches the resolved mode (does not re-read env)', () => {
    process.env.MEADOW_MODE = 'box';
    _resetModeForTests();
    expect(getMode()).toBe('box');
    process.env.MEADOW_MODE = 'api';
    expect(getMode()).toBe('box'); // still cached
    _resetModeForTests();
    expect(getMode()).toBe('api'); // re-resolved
  });
});

describe('boxModeProxy', () => {
  // Test the proxy directly rather than re-importing the connection
  // module: the suite shares a single fork (singleFork: true), so any
  // dynamic re-import would mutate the cached `db` reference for every
  // OTHER test file that already imported it — and they'd start
  // hitting "db.query() called in box mode" mid-suite.
  it('throws on query() with a clear message', () => {
    const proxy = boxModeProxy();
    expect(() => proxy.query('SELECT 1')).toThrow(/box mode/);
  });

  it('throws on connect() with a clear message', () => {
    const proxy = boxModeProxy();
    expect(() => proxy.connect()).toThrow(/box mode/);
  });

  it('silently no-ops .on("error") so production wiring (db.on("error", ...)) does not blow up at boot', () => {
    const proxy = boxModeProxy();
    expect(() =>
      proxy.on('error', () => {
        /* no-op */
      }),
    ).not.toThrow();
  });

  it('end() resolves cleanly so graceful shutdown still works in box mode', async () => {
    const proxy = boxModeProxy();
    await expect(proxy.end()).resolves.toBeUndefined();
  });
});
