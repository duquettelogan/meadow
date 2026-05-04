import rateLimit from 'express-rate-limit';

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
 */

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many login attempts, try again later' },
  // Don't count successful logins.
  skipSuccessfulRequests: true,
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too many signup attempts, try again later' },
});

export const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate limit exceeded' },
});

export const defaultLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'rate limit exceeded' },
});
