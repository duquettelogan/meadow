/**
 * Transactional email — provider-agnostic interface.
 *
 * For Phase 4.4 we only need two flows: email verification and password
 * reset. Both send a short message with a tokenized URL. Volume is tiny
 * (one or two emails per parent ever), so any provider works.
 *
 * Provider selection (in priority order):
 *   - RESEND_API_KEY  → Resend HTTP API (production)
 *   - none            → ConsoleEmailProvider (dev, tests, unconfigured prod)
 *
 * Adding a new provider: implement EmailProvider, branch on the matching
 * env var in chooseProvider().
 *
 * Privacy posture: the email body contains a tokenized URL, never the
 * password itself, never any blocked-domain or block-counter data.
 */

const FROM_ADDRESS = process.env.MEADOW_FROM_EMAIL || 'Meadow <hello@dqsec.com>';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(msg: EmailMessage): Promise<void>;
  name(): string;
}

class ConsoleEmailProvider implements EmailProvider {
  name(): string {
    return 'console';
  }
  async send(msg: EmailMessage): Promise<void> {
    console.log('---- EMAIL ----');
    console.log('From:   ', FROM_ADDRESS);
    console.log('To:     ', msg.to);
    console.log('Subject:', msg.subject);
    console.log(msg.text);
    console.log('---------------');
  }
}

class ResendEmailProvider implements EmailProvider {
  constructor(private apiKey: string) {}

  name(): string {
    return 'resend';
  }

  async send(msg: EmailMessage): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);

    try {
      const res = await fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_ADDRESS,
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        // Read the body for diagnostics but don't throw — caller swallows
        // errors anyway; we just want a useful log line. Cap the read so a
        // misbehaving provider can't dump megabytes into our logs.
        let detail = '';
        try {
          detail = (await res.text()).slice(0, 500);
        } catch {
          // ignore body read failure
        }
        throw new Error(`Resend HTTP ${res.status}: ${detail}`);
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

let cached: EmailProvider | null = null;

function chooseProvider(): EmailProvider {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey && resendKey.trim().length > 0) {
    console.log('[email] using Resend provider');
    return new ResendEmailProvider(resendKey.trim());
  }
  if (process.env.POSTMARK_TOKEN) {
    console.warn(
      '[email] POSTMARK_TOKEN set but no Postmark adapter — falling back to console',
    );
  }
  return new ConsoleEmailProvider();
}

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  cached = chooseProvider();
  return cached;
}

/**
 * Convenience helpers for the canonical flows. Both are best-effort
 * (await but swallow errors) so the API call that triggered the email
 * still succeeds even if the provider is down.
 */
export async function sendVerificationEmail(
  to: string,
  token: string,
  baseUrl?: string,
): Promise<void> {
  const url = `${baseUrl ?? defaultBaseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  try {
    await getEmailProvider().send({
      to,
      subject: 'Verify your Meadow email',
      text: `Welcome to Meadow.\n\nConfirm this email by visiting:\n${url}\n\nThis link expires in 24 hours.`,
    });
  } catch (err) {
    console.error('[email] verification send failed:', err);
  }
}

export async function sendPasswordResetEmail(
  to: string,
  token: string,
  baseUrl?: string,
): Promise<void> {
  const url = `${baseUrl ?? defaultBaseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await getEmailProvider().send({
      to,
      subject: 'Reset your Meadow password',
      text: `Someone requested a password reset for your Meadow account.\n\nIf this was you, reset here:\n${url}\n\nThis link expires in 1 hour.\n\nIf this wasn't you, ignore this email — your password hasn't changed.`,
    });
  } catch (err) {
    console.error('[email] password reset send failed:', err);
  }
}

function defaultBaseUrl(): string {
  return process.env.DASHBOARD_URL || 'https://meadow.dqsec.com';
}

export function _resetEmailProviderForTests(): void {
  cached = null;
}
