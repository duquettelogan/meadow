# Security Hardening (Phase 4)

What landed in this branch and what's deliberately deferred. Read this
before sending a box outside the household.

## Done

### 4.1 — DoH endpoint authentication

`/dns-query` (POST + GET) now requires a Bearer device API key. Open
recursive resolvers are routinely abused for DDoS amplification, so we
gate the endpoint behind the same key the box uses for `/api/v1/resolve`.

Browsers can't currently use this DoH endpoint because the DoH spec
doesn't allow auth headers — that's intentional for v1. The home box
serves UDP/53 on the LAN; devices on the LAN never need DoH. The "off-
network protection" use case (devices using meadow's DoH from anywhere)
is v2 and will introduce per-device path-encoded tokens (`/dns-query/<token>`).

Operational note: `scripts/test-doh-blocking.sh` now needs
`MEADOW_API_KEY=mk_...` in the env.

### 4.3 — JWT revocation

Each parent JWT now carries a unique `jti`. We track revocations in Redis
two ways:
- **Per-token (`jti`)** — set on `/api/v1/auth/logout`. Other devices keep
  working.
- **Per-parent floor** — set on password change/reset. Any token issued
  before the floor timestamp is rejected. Forces re-login everywhere.

Redis outage falls open (we log + allow the token) rather than locking
everyone out. This is a deliberate availability trade — the alternative
(deny-on-error) makes a Redis blip into a global outage of dashboards.

### 4.4 — Email verification + password recovery

Schema, endpoints, and token plumbing are live:
- `POST /api/v1/auth/verify-email`
- `POST /api/v1/auth/forgot-password`
- `POST /api/v1/auth/reset-password`
- `POST /api/v1/auth/change-password`
- `POST /api/v1/auth/logout`

Tokens are 32-byte base64url, time-limited (24h verify, 1h reset). Reset
and change rotate the password and revoke all sessions for that parent.

**Resend adapter (`src/email/`) is wired.** Set `RESEND_API_KEY` in
`fly secrets` to enable real delivery. From address defaults to
`Meadow <hello@dqsec.com>` (override with `MEADOW_FROM_EMAIL`). When
the env var is empty/unset, the provider falls back to a console
logger so dev and tests still work without credentials. Bounded with
a 10s AbortController timeout; non-2xx and network errors are logged
and swallowed so a Resend outage never blocks signup or password reset.

The flow does NOT enumerate accounts: `/forgot-password` returns 200
even for unknown emails.

**Soft verification gate is live.** `requireVerifiedParent` middleware
sits behind `requireParentAuth` on:

- `POST /api/v1/children` (new child profile)
- `POST /api/v1/pairing/claim-by-code` (claiming a hardware box)

Unverified parents get `403 {"error":"email_not_verified"}`. Login,
/me, password reset, and `POST /api/v1/auth/resend-verification` stay
open so a parent can always sign in, see their verification state,
and trigger another email. Resend-verification is rate-limited via
the shared password-reset limiter (5/hour) and is idempotent for
already-verified parents (returns `{success: true, already_verified: true}`).

### 4.6 — Audit logging

`audit_log` table records security-relevant actions: signup, login,
failed login, logout, password change/reset/verify, child create,
policy update, device register, device key issue/revoke, pairing start,
pairing claim, pairing hardware-id mismatch, box heartbeat (sampled).

Privacy: rows record WHO did WHAT, never the contents (no domain names,
no email subjects, no policy values — only the field names that were
changed). Append-only; no UPDATE / DELETE in normal flow.

Indexes support `(family_id, occurred_at DESC)` and `(action, occurred_at DESC)`.

### 4.7 — Hardening checklist

- Pairing code widened from 6 → 8 digits (1M → 100M space). 100x harder
  to brute force; defense-in-depth on top of the existing 10-attempt /
  15-min rate limit.
- Dependabot configured (`.github/dependabot.yml`) — weekly grouped
  npm + monthly GitHub Actions.
- `npm audit --audit-level=high` runs in CI on every push/PR.
- Helmet headers + CORS allowlist already in place.

## Deferred

### 4.2 — Replay protection on device API calls

Adding nonce + timestamp to the HMAC contract is non-trivial — it
requires matching changes in the box-side code (which currently sends
plain Bearer-style API key auth, no payload signing). The shape:
include `X-Meadow-Timestamp` + `X-Meadow-Nonce` headers, sign
`HMAC(secret, timestamp + ":" + nonce + ":" + body)`, reject anything
older than 5 minutes.

Status: queued for v1.5. Pre-Japan, the existing key auth + HTTPS is
acceptable — replay attacks need the key in the first place, and HTTPS
makes that hard to grab. Document the gap in pen test scope.

### 4.5 — 2FA for parents

Schema columns exist (`parents.totp_secret_encrypted`, `parents.totp_enabled_at`)
so we can enroll without a follow-up migration. The actual enrollment +
verify flow is not wired into login — that lands when the dashboard
ships the QR-code enrollment UI. Until then the columns sit unused.

Status: scaffold-only for v1. Mandatory in v1.5 per the original plan.

## Operator follow-ups

1. **Resend account + DNS** — sign up at resend.com, add the dqsec.com
   domain, verify the DNS records Resend provides, generate an API key,
   `fly secrets set RESEND_API_KEY=re_...`. Adapter is already wired.
2. **TOTP encryption key** — when 4.5 lands, it'll need a `TOTP_ENCRYPTION_KEY`
   secret to encrypt the seed before storing. Generate with `openssl rand -hex 32`.
3. **Cloudflare in front of Fly** — flip the orange cloud once TLS is
   stable. Adds DDoS protection, bot filtering, and per-route rate
   limits beyond what express-rate-limit can do.
4. **Pen test** — book one before any non-household deployment. Scope
   should explicitly include: pairing brute force, DoH amplification
   (post-4.1 lock), token-replay (acknowledge the gap), email-token
   timing, and audit-log integrity.
