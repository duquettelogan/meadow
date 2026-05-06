import { z } from 'zod';

/**
 * Validation schemas for every endpoint that accepts a request body.
 *
 * All schemas reject unknown fields by default — extra keys cause a 400
 * instead of being silently dropped. Stops malicious payloads from sneaking
 * fields past validation.
 */

const email = z
  .string()
  .min(3)
  .max(254)
  .email()
  .transform((s) => s.toLowerCase().trim());

const password = z.string().min(12).max(200);

const uuid = z.string().uuid();

const tier = z.enum(['strict', 'standard', 'light']);

const domain = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-zA-Z0-9.-]+$/, 'invalid domain');

const url = z.string().url().max(2048);

const platform = z.enum([
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'xbox',
  'playstation',
  'switch',
  'smarttv',
  'router',
  'other',
]);

const deviceToken = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'invalid device_token');

const apiKey = z
  .string()
  .startsWith('mk_')
  .min(11)
  .max(80)
  .regex(/^mk_[a-f0-9]+$/, 'invalid api key format');

// ---------- Auth ----------
export const SignupBody = z
  .object({
    email,
    password,
  })
  .strict();

export const LoginBody = z
  .object({
    email,
    password: z.string().min(1).max(200), // looser for login (errors caught by mismatch)
  })
  .strict();

// ---------- Children ----------
export const CreateChildBody = z
  .object({
    name: z.string().min(1).max(80).trim(),
    tier: tier.optional(),
  })
  .strict();

export const UpdatePolicyBody = z
  .object({
    blocked_categories: z.array(z.string().max(80)).max(50).optional(),
    allowed_domains: z.array(domain).max(500).optional(),
    blocked_domains: z.array(domain).max(500).optional(),
    safe_search_enforce: z.boolean().optional(),
    youtube_restrict: z.boolean().optional(),
  })
  .strict();

// ---------- Devices ----------
export const RegisterDeviceBody = z
  .object({
    child_profile_id: uuid.optional(),
    platform,
    device_token: deviceToken,
  })
  .strict();

// ---------- Resolver ----------
export const ResolveBody = z
  .object({
    domain,
  })
  .strict();

export const AnalyzeBody = z
  .object({
    url,
  })
  .strict();

// ---------- Heartbeat ----------
// Box health snapshot. All fields optional so we can extend the contract
// without breaking older boxes.
export const HeartbeatBody = z
  .object({
    ts: z.number().int().nonnegative().optional(),
    uptime_seconds: z.number().int().nonnegative().max(60 * 60 * 24 * 365 * 10).optional(),
    free_memory_mb: z.number().int().nonnegative().max(1024 * 1024).optional(),
    blocklist_versions: z
      .record(z.string().max(80), z.union([z.string().max(120), z.number()]))
      .optional(),
    box_version: z.string().max(80).optional(),
  })
  .strict();

// ---------- Pairing ----------
const hardwareId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, 'invalid hardware_id');

// Code format: XXXX-XXXX or XXXXXXXX (8 digits). 100M combinations,
// 100x harder to brute force than the v0 6-digit code. Server
// normalizes by stripping non-digits before lookup.
const pairingCode = z
  .string()
  .min(8)
  .max(9)
  .regex(/^[\d]{4}-?[\d]{4}$/, 'invalid pairing code (expected XXXX-XXXX)');

export const PairingStartBody = z
  .object({
    hardware_id: hardwareId,
    platform,
  })
  .strict();

export const PairingClaimBody = z
  .object({
    code: pairingCode,
    child_profile_id: uuid,
  })
  .strict();

export const PairingPollBody = z
  .object({
    code: pairingCode,
    hardware_id: hardwareId,
  })
  .strict();

// ---------- Email verification + password recovery ----------
const recoveryToken = z.string().min(20).max(200).regex(/^[a-zA-Z0-9_-]+$/);

export const VerifyEmailBody = z
  .object({
    token: recoveryToken,
  })
  .strict();

export const ForgotPasswordBody = z
  .object({
    email,
  })
  .strict();

export const ResetPasswordBody = z
  .object({
    token: recoveryToken,
    password,
  })
  .strict();

export const ChangePasswordBody = z
  .object({
    current_password: z.string().min(1).max(200),
    new_password: password,
  })
  .strict();

// ---------- Helpers ----------
export type ZodIssueResponse = { error: string; details?: unknown };

export function formatZodError(err: z.ZodError): ZodIssueResponse {
  return {
    error: 'invalid request',
    details: err.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    })),
  };
}
