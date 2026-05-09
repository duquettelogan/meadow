import rateLimit, { Options } from 'express-rate-limit';

/**
 * Rate limiters.
 *
 * Login: 10 failed attempts per IP per minute. Originally 5 per 15min,
 *        loosened during alpha so legitimate "I fat-fingered my
 *        password three times" testing doesn't lock the operator out.
 *        skipSuccessfulRequests is still on, so successful logins
 *        don't count toward the bucket.
 * Signup: 5 per IP per hour. Prevents account spam.
 * Resolve: 600/min per IP. Plenty for legitimate DNS but stops floods.
 * Default: 60/min per IP for everything else.
 *
 * Admin allowlist (env IS_ADMIN_EMAIL — comma separated) is exempted
 * from every limiter. The check looks at req.body.email when present,
 * so login/signup/forgot-password/etc. all match. Limiters that don't
 * see an email in the body (resolve, default, pairing-device) just
 * apply the normal limit — admins don't realistically hit those.
 *
 * Note: these are IP-based. Behind a load balancer you need to set
 * app.set('trust proxy', 1) so req.ip reflects the real client.
 *
 * Set DISABLE_RATE_LIMITS=1 to skip enforcement (tests, local debugging).
 */

const DISABLED = process.env.DISABLE_RATE_LIMITS === '1';

function isAdminEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const allowlist = (process.env.IS_ADMIN_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;
  return allowlist.includes(email.toLowerCase());
}

function makeLimiter(opts: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    ...opts,
    // Skip after the spread so it composes with — and supersedes —
    // any per-limiter skip the caller provided.
    skip: (req, res) => {
      if (DISABLED) return true;
      if (isAdminEmail((req.body as { email?: unknown } | undefined)?.email)) {
        return true;
      }
      return typeof opts.skip === 'function' ? opts.skip(req, res) : false;
    },
  });
}

export const loginLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  message: { error: 'too many login attempts, try again later' },
  skipSuccessfulRequests: true,
});

export const signupLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: 'too many signup attempts, try again later' },
});

export const resolveLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 600,
  message: { error: 'rate limit exceeded' },
});

export const defaultLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 60,
  message: { error: 'rate limit exceeded' },
});

// Pairing claim — even though we widened the code to 8 digits (100M
// space), keep the strict limit. Defense in depth.
export const pairingClaimLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: { error: 'too many pairing attempts, try again later' },
});

// Password reset (forgot + reset endpoints): 5 per IP per hour. Stops
// reset-spam without making legitimate "I forgot, send another" hard.
export const passwordResetLimiter = makeLimiter({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: 'too many password reset requests, try again later' },
});

// Pairing start and poll are device-side — these are forgiving, just
// keeping a sanity ceiling so a misbehaving device can't DoS the server.
export const pairingDeviceLimiter = makeLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  message: { error: 'rate limit exceeded' },
});
