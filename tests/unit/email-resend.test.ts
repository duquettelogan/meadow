import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getEmailProvider,
  sendVerificationEmail,
  _resetEmailProviderForTests,
} from '../../src/email';

describe('Resend adapter', () => {
  const originalKey = process.env.RESEND_API_KEY;
  const originalDashboard = process.env.DASHBOARD_URL;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    process.env.RESEND_API_KEY = 're_test_key_123';
    process.env.DASHBOARD_URL = 'https://meadow.example.com';
    _resetEmailProviderForTests();
    fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'em_xxx' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalKey;
    }
    if (originalDashboard === undefined) {
      delete process.env.DASHBOARD_URL;
    } else {
      process.env.DASHBOARD_URL = originalDashboard;
    }
    _resetEmailProviderForTests();
  });

  it('selects the Resend provider when RESEND_API_KEY is set', () => {
    expect(getEmailProvider().name()).toBe('resend');
  });

  it('falls back to console when RESEND_API_KEY is missing', () => {
    delete process.env.RESEND_API_KEY;
    _resetEmailProviderForTests();
    expect(getEmailProvider().name()).toBe('console');
  });

  it('falls back to console when RESEND_API_KEY is empty / whitespace', () => {
    process.env.RESEND_API_KEY = '   ';
    _resetEmailProviderForTests();
    expect(getEmailProvider().name()).toBe('console');
  });

  it('POSTs the right shape to Resend for a verification email', async () => {
    await sendVerificationEmail('parent@example.com', 'tok_abc');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];

    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer re_test_key_123',
      'Content-Type': 'application/json',
    });

    const body = JSON.parse(init.body as string);
    expect(body.from).toBe('Meadow <hello@dqsec.com>');
    expect(body.to).toBe('parent@example.com');
    expect(body.subject).toBe('Verify your Meadow email');
    // The link must include the dashboard URL and the URL-encoded token.
    expect(body.text).toContain(
      'https://meadow.example.com/verify-email?token=tok_abc',
    );
  });

  it('POSTs the right shape to Resend for a password reset', async () => {
    const { sendPasswordResetEmail } = await import('../../src/email');
    await sendPasswordResetEmail('parent@example.com', 'reset_tok+/=');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);

    expect(body.subject).toBe('Reset your Meadow password');
    // Token must be URL-encoded inside the link.
    expect(body.text).toContain(
      'https://meadow.example.com/reset-password?token=reset_tok%2B%2F%3D',
    );
  });

  it('respects MEADOW_FROM_EMAIL override', async () => {
    process.env.MEADOW_FROM_EMAIL = 'Meadow Support <support@dqsec.com>';
    // Re-import to pick up the new constant — module-scoped at load time.
    vi.resetModules();
    _resetEmailProviderForTests();
    const { sendVerificationEmail: send } = await import('../../src/email');
    await send('parent@example.com', 'tok');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.from).toBe('Meadow Support <support@dqsec.com>');
    delete process.env.MEADOW_FROM_EMAIL;
  });

  it('swallows non-2xx responses without throwing past the helper', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('rate limited', { status: 429 }),
    );
    // Should not throw — sendVerificationEmail catches internally.
    await expect(
      sendVerificationEmail('parent@example.com', 'tok'),
    ).resolves.toBeUndefined();
  });

  it('swallows network errors without throwing past the helper', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(
      sendVerificationEmail('parent@example.com', 'tok'),
    ).resolves.toBeUndefined();
  });
});
