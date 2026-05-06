#!/usr/bin/env bash
# DoH bypass blocking smoke test.
#
# Verifies the resolver blocks known DoH endpoints once the intel feed has
# populated Redis. Requires a running server AND a paired device API key
# (Phase 4.1: /dns-query is now Bearer-gated to prevent open recursive
# resolver abuse).
#
# Usage:
#   MEADOW_API_KEY=mk_... ./scripts/test-doh-blocking.sh
#
# Get an API key by walking through the pairing flow once with sim-device:
#   npx ts-node scripts/sim-device.ts
#   # ...claim the code in the dashboard, then read the key from .sim-device.json

set -u
BASE="${BASE_URL:-http://localhost:3000}"
API_KEY="${MEADOW_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  printf "\033[31mFAIL\033[0m  set MEADOW_API_KEY=mk_... before running (see header)\n" >&2
  exit 2
fi

pass() { printf "  \033[32mPASS\033[0m  %s\n" "$1"; }
fail() { printf "  \033[31mFAIL\033[0m  %s\n" "$1"; FAILED=1; }
section() { printf "\n\033[1m%s\033[0m\n" "$1"; }

FAILED=0

# Sample of DoH endpoints that should be blocked.
DOH_DOMAINS=(
  "cloudflare-dns.com"
  "dns.google"
  "dns.quad9.net"
  "dns.nextdns.io"
  "dns.adguard.com"
  "doh.opendns.com"
)

# Sample of safe domains that should NOT be blocked by doh_bypass.
SAFE_DOMAINS=(
  "wikipedia.org"
  "example.com"
)

# Use the DoH endpoint directly (unauthenticated, returns DNS message bytes).
# We send a base64-encoded DNS query and check whether the response is a
# blocked answer (0.0.0.0) or a real upstream answer.
#
# Easier approach: just hit a Redis-aware healthcheck endpoint, but we
# don't have one yet. So we use the DoH endpoint and parse the output.
#
# For now, simpler check: the DoH endpoint should return a response for
# a DoH-bypass domain that resolves to 0.0.0.0.

# Encode a DNS query for the given domain (A record).
encode_query() {
  local domain="$1"
  python3 -c "
import base64, struct
domain = '$domain'
# DNS header: id=0, flags=0x0100 (recursion desired), 1 question
header = struct.pack('>HHHHHH', 0, 0x0100, 1, 0, 0, 0)
# QNAME: length-prefixed labels
qname = b''
for label in domain.split('.'):
    qname += struct.pack('>B', len(label)) + label.encode()
qname += b'\x00'
# QTYPE=A (1), QCLASS=IN (1)
question = qname + struct.pack('>HH', 1, 1)
print(base64.urlsafe_b64encode(header + question).decode().rstrip('='))
"
}

# Decode response and extract the answer IP (just first A record).
extract_ip() {
  python3 -c "
import sys, struct
data = sys.stdin.buffer.read()
if len(data) < 12:
    print('short')
    sys.exit(0)
# Skip header (12 bytes) and question.
i = 12
# Skip QNAME
while i < len(data) and data[i] != 0:
    i += data[i] + 1
i += 1  # null terminator
i += 4  # QTYPE + QCLASS
# Read first answer if any
ancount = struct.unpack('>H', data[6:8])[0]
if ancount == 0:
    print('no_answer')
    sys.exit(0)
# Skip name (compressed pointer or labels)
if data[i] & 0xc0:
    i += 2
else:
    while i < len(data) and data[i] != 0:
        i += data[i] + 1
    i += 1
# TYPE(2) CLASS(2) TTL(4) RDLENGTH(2)
i += 10
# IP is next 4 bytes for an A record
if i + 4 > len(data):
    print('truncated')
    sys.exit(0)
ip = '.'.join(str(b) for b in data[i:i+4])
print(ip)
"
}

section "1. Server reachable"
code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/health")
[ "$code" = "200" ] && pass "/health returns 200" || { fail "/health returned $code"; exit 1; }

section "2. DoH bypass domains return 0.0.0.0 (blocked)"
for domain in "${DOH_DOMAINS[@]}"; do
  query=$(encode_query "$domain")
  ip=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE/dns-query?dns=$query" | extract_ip)
  if [ "$ip" = "0.0.0.0" ]; then
    pass "$domain → blocked"
  else
    fail "$domain → expected 0.0.0.0, got $ip"
  fi
done

section "3. Safe domains resolve normally (not blocked by doh_bypass)"
for domain in "${SAFE_DOMAINS[@]}"; do
  query=$(encode_query "$domain")
  ip=$(curl -s -H "Authorization: Bearer $API_KEY" "$BASE/dns-query?dns=$query" | extract_ip)
  if [ "$ip" = "0.0.0.0" ]; then
    fail "$domain → unexpectedly blocked (got 0.0.0.0)"
  elif [ "$ip" = "no_answer" ] || [ "$ip" = "short" ] || [ "$ip" = "truncated" ]; then
    fail "$domain → bad response: $ip"
  else
    pass "$domain → resolved to $ip"
  fi
done

section "Summary"
if [ "$FAILED" = "0" ]; then
  printf "\033[32mAll DoH blocking checks passed.\033[0m\n"
  exit 0
else
  printf "\033[31mSome DoH blocking checks failed.\033[0m\n"
  exit 1
fi
