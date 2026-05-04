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

**Integration tests** (`tests/integration/`):
- Signup → login → /me round-trip
- Duplicate signup rejection
- Validation rejections (bad email, short password)
- Auth gates (no token, bad token)
- Family scoping (parent A can't read parent B's child)
- Child create + policy update
- Device API key generation, plaintext shown once, cross-family blocked
- Public endpoints (/health, 404 handler)
