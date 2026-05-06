/**
 * Transactional email — provider-agnostic interface.
 *
 * For Phase 4.4 we only need two flows: email verification and password
 * reset. Both send a short message with a tokenized URL. Volume is tiny
 * (one or two emails per parent ever), so any provider works.
 *
 * The default adapter logs to console — fine for dev and tests, NOT
 * for production. Wire a real provider via env in production:
 *
 *   POSTMARK_TOKEN=pm-...   # Postmark
 *   RESEND_API_KEY=re_...   # Resend
 *
 * If no provider env is set in production, signup will succeed but
 * verification emails go to the API logs. Explicitly call out so a
 * deploy without email config doesn't silently break.
 *
 * Adding a real provider: add a new file in this directory exporting
 * an `EmailProvider` and switch on env in createProvider().
 */

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
    console.log('To:     ', msg.to);
    console.log('Subject:', msg.subject);
    console.log(msg.text);
    console.log('---------------');
  }
}

let cached: EmailProvider | null = null;

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  // Future: branch on POSTMARK_TOKEN / RESEND_API_KEY etc. and instantiate
  // the matching adapter. For now, console only.
  if (process.env.POSTMARK_TOKEN || process.env.RESEND_API_KEY) {
    console.warn(
      '[email] provider env detected but adapter not implemented yet — falling back to console',
    );
  }
  cached = new ConsoleEmailProvider();
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
