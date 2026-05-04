import rateLimit, { Options } from 'express-rate-limit';

/**
 * Rate limiters.
 *
 * Login: 5 attempts per IP per 15min. Stops basic credential stuffing.
 * Signup: 5 per IP per hour. Prevents account spam.
 * Resolve: 600/min per IP. Plenty for legitimate DNS but stops floods.
 * Default: 60/min per IP for everything else.
 *
 * Note: these are IP-based. Behind a load balancer you need to set
 * app.set('trust proxy', 1) so req.ip reflects the real client.
 *
 * Set DISABLE_RATE_LIMITS=1 to skip enforcement (tests, local debugging).
 */

const DISABLED = process.env.DISABLE_RATE_LIMITS === '1';

function makeLimiter(opts: Partial<Options>) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => DISABLED,
    ...opts,
  });
}

export const loginLimiter = makeLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 5,
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
