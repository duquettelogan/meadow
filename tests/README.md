# Meadow Tests

Vitest-based unit and integration tests.

## Setup (one-time)

Tests run against a separate Postgres database `meadow_test` so they don't
touch dev data.

```sh
# Create the test DB and run migrations against it.
npm run test:setup
```

## Running

```sh
npm test                 # all tests, exits 0/1
npm run test:unit        # unit tests only (no DB needed)
npm run test:integration # integration tests (needs Postgres)
npm run test:watch       # interactive watch mode
```

Postgres and Redis must be running locally for integration tests.

## What's covered

**Unit tests** (`tests/unit/`):
- Password hashing + verification + validation
- API key generation, HMAC verification, constant-time compare
- JWT signing + verification + tamper detection
- Zod request validation schemas
- Threat intel feed parser (hosts/domains formats)
- DNS handler pipeline: crisis floor, captive portal, AAAA blocking,
  per-child policy (parent allow/block + suffix matching), safe-search
  rewrites (Google + ccTLDs, Bing), YouTube restricted-mode rewrite
- Captive-portal allowlist matching
- Per-child policy loader: caching, jsonb shapes, list matching

**Integration tests** (`tests/integration/`):
- Signup → login → /me round-trip
- Duplicate signup rejection
- Validation rejections (bad email, short password)
- Auth gates (no token, bad token)
- Family scoping (parent A can't read parent B's child)
- Child create + policy update
- Device API key generation, plaintext shown once, cross-family blocked
- Public endpoints (/health, 404 handler)
- Pairing flow (start → claim → poll, hardware_id check, double-claim,
  invalid-code, requires auth) — uses 8-digit codes (Phase 4.7)
- Heartbeat: 204 + last_seen/last_health_payload write, auth gates,
  unknown-field rejection
- HTTP resolver crisis floor + captive portal short-circuits
- Audit log: signup / failed-login / child-create / policy-update writes
  with expected fields
- Email verification end-to-end (token issued on signup → cleared on verify)
- Password recovery: forgot-password → reset-password (rotates pw,
  revokes old sessions); change-password authenticated; logout
  (single-session) — no email enumeration on forgot
- /dns-query Bearer auth gate (Phase 4.1)
- Email-verification soft gate: 403 email_not_verified on POST /children
  and POST /pairing/claim for unverified parents; login / /me /
  resend-verification stay open; /resend-verification idempotent for
  already-verified parents
