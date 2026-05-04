#!/usr/bin/env bash
# Meadow hardening smoke tests.
# Hits the running server (default localhost:3000) and verifies:
#   - validation rejects bad input
#   - rate limits trigger
#   - auth gates work
#
# Usage: ./scripts/smoke-test.sh
#        BASE_URL=http://localhost:3000 ./scripts/smoke-test.sh

set -u
BASE="${BASE_URL:-http://localhost:3000}"

pass() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAILED=1; }
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

FAILED=0

# Get just the HTTP status code from a request.
status() {
  curl -s -o /dev/null -w "%{http_code}" "$@"
}

section "1. Health check"
code=$(status "$BASE/health")
[ "$code" = "200" ] && pass "/health returns 200" || fail "/health returned $code"

section "2. Validation"

code=$(status -X POST "$BASE/api/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"notanemail","password":"shortpw"}')
[ "$code" = "400" ] && pass "rejects invalid email + short password" \
  || fail "expected 400, got $code"

code=$(status -X POST "$BASE/api/v1/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email":"good@example.com","password":"longenoughpass","extra":"field"}')
[ "$code" = "400" ] && pass "rejects unknown field (strict schema)" \
  || fail "expected 400 for unknown field, got $code"

section "3. Auth gates"

code=$(status -X POST "$BASE/api/v1/children" \
  -H "Content-Type: application/json" \
  -d '{"name":"Kid"}')
[ "$code" = "401" ] && pass "/children blocked without token" \
  || fail "expected 401, got $code"

code=$(status -X POST "$BASE/api/v1/children" \
  -H "Authorization: Bearer notarealtoken" \
  -H "Content-Type: application/json" \
  -d '{"name":"Kid"}')
[ "$code" = "401" ] && pass "/children rejects bad token" \
  || fail "expected 401, got $code"

section "4. Rate limit: login (5/15min)"

# Hit login 6 times. The 6th should be 429.
hit_count=0
limited=0
last_code=""
for i in $(seq 1 8); do
  code=$(status -X POST "$BASE/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d '{"email":"ratetest@example.com","password":"wrongpassword"}')
  last_code="$code"
  hit_count=$((hit_count + 1))
  if [ "$code" = "429" ]; then
    limited=1
    break
  fi
done

if [ "$limited" = "1" ]; then
  pass "login rate-limited after $hit_count attempts (got 429)"
else
  fail "login never rate-limited after 8 attempts (last code: $last_code)"
fi

section "5. Rate limit: default (60/min)"

# Hit a parent-authed endpoint 70 times without auth.
# Each returns 401, but rate limit should fire around 60.
limited=0
hit_count=0
for i in $(seq 1 70); do
  code=$(status "$BASE/api/v1/families/me")
  hit_count=$((hit_count + 1))
  if [ "$code" = "429" ]; then
    limited=1
    break
  fi
done

if [ "$limited" = "1" ]; then
  pass "default rate limit fired after $hit_count requests"
else
  fail "default rate limit never fired in 70 requests"
fi

section "6. CORS"

# Request from an allowed origin should get the CORS header.
header=$(curl -s -I -H "Origin: http://localhost:5173" "$BASE/health" \
  | grep -i "access-control-allow-origin" || true)
if [ -n "$header" ]; then
  pass "CORS allows configured origin"
else
  fail "expected CORS header for allowed origin, got none"
fi

# Request from a disallowed origin should NOT get the CORS header.
header=$(curl -s -I -H "Origin: http://evil.example.com" "$BASE/health" \
  | grep -i "access-control-allow-origin" || true)
if [ -z "$header" ]; then
  pass "CORS blocks disallowed origin"
else
  fail "expected no CORS header for blocked origin, got: $header"
fi

section "7. Security headers (helmet)"

headers=$(curl -s -I "$BASE/health")
echo "$headers" | grep -qi "x-content-type-options" \
  && pass "X-Content-Type-Options present" \
  || fail "missing X-Content-Type-Options"
echo "$headers" | grep -qi "strict-transport-security" \
  && pass "Strict-Transport-Security present" \
  || fail "missing Strict-Transport-Security"

section "Summary"

if [ "$FAILED" = "0" ]; then
  printf "\033[32mAll checks passed.\033[0m\n"
  exit 0
else
  printf "\033[31mSome checks failed.\033[0m\n"
  exit 1
fi
