#!/usr/bin/env bash
# Pi-specific setup for Meadow.
#
# Run AFTER install.sh has succeeded. Configures the box to actually
# function as the home network's DNS server:
#   - Sets hostname to "meadow"
#   - Configures UFW firewall (SSH, DNS, API)
#   - Disables systemd-resolved so port 53 is free for Meadow
#   - Reduces swap aggressiveness for SD card longevity
#
# Meadow itself listens on UDP/53 thanks to CAP_NET_BIND_SERVICE in the
# systemd unit. No dnsmasq, no cloudflared — Meadow IS the DNS server.
#
# Usage:
#   sudo ./pi-setup.sh

set -euo pipefail

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
step()  { printf "\n${BOLD}==> %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
die()   { printf "  ${RED}✗ %s${RESET}\n" "$1" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "must be run as root (use sudo)"

step "Time sync (NTP)"
# Pi has no RTC. Without NTP the clock is at epoch on boot and HTTPS to
# the API + intel feeds fails cert validation. systemd-timesyncd ships
# with all current Debian/Ubuntu/Pi OS releases; chrony is a fallback if
# someone built a custom image without it.
if systemctl list-unit-files | grep -q '^systemd-timesyncd\.service'; then
  systemctl enable -q --now systemd-timesyncd
  ok "systemd-timesyncd enabled"
elif command -v chronyd >/dev/null 2>&1; then
  systemctl enable -q --now chrony
  ok "chrony enabled"
else
  apt-get install -y -qq systemd-timesyncd >/dev/null 2>&1 || apt-get install -y -qq chrony >/dev/null 2>&1
  systemctl enable -q --now systemd-timesyncd 2>/dev/null || systemctl enable -q --now chrony
  ok "installed and enabled time sync daemon"
fi

# Wait for time to settle. timedatectl reports "synchronized" once
# the daemon has its first peer answer. 30s upper bound — if the box
# can't reach NTP that long, something else is wrong upstream.
for i in $(seq 1 30); do
  if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
    ok "system clock is synchronized"
    break
  fi
  sleep 1
  if [ "$i" = "30" ]; then
    warn "time did not synchronize within 30s — services may still come up but check: timedatectl"
  fi
done

step "Hostname"
HOSTNAME="meadow"
if [ "$(hostname)" != "$HOSTNAME" ]; then
  hostnamectl set-hostname "$HOSTNAME"
  if grep -q "^127.0.1.1" /etc/hosts; then
    sed -i "s/^127.0.1.1.*/127.0.1.1\t$HOSTNAME/" /etc/hosts
  else
    echo -e "127.0.1.1\t$HOSTNAME" >> /etc/hosts
  fi
  ok "hostname set to $HOSTNAME"
else
  ok "hostname already $HOSTNAME"
fi

step "Freeing port 53 (disabling systemd-resolved)"
# systemd-resolved binds 127.0.0.53:53 by default and conflicts with Meadow
# wanting to bind 0.0.0.0:53. Stop it cleanly and replace /etc/resolv.conf.
if systemctl is-active -q systemd-resolved; then
  systemctl stop systemd-resolved
  systemctl disable -q systemd-resolved
  ok "stopped systemd-resolved"
else
  ok "systemd-resolved already inactive"
fi

# Replace symlinked resolv.conf with one pointing at upstream directly.
# Meadow itself uses UPSTREAM_DNS env var for forwarding, not /etc/resolv.conf,
# but the OS itself still needs DNS for apt updates etc.
if [ -L /etc/resolv.conf ] || ! grep -q '^nameserver' /etc/resolv.conf 2>/dev/null; then
  rm -f /etc/resolv.conf
  cat > /etc/resolv.conf <<'EOF'
# Managed by Meadow pi-setup.sh. Used by the OS itself (apt, ntp, etc.).
# Devices on the LAN should point at this Pi's LAN IP, which is served
# by the Meadow daemon on UDP/53.
nameserver 1.1.1.1
nameserver 1.0.0.1
EOF
  ok "wrote /etc/resolv.conf"
else
  ok "/etc/resolv.conf already configured"
fi

step "Restarting Meadow to claim port 53"
systemctl restart meadow
sleep 2
if ss -lun 2>/dev/null | grep -q ':53 '; then
  ok "Meadow listening on UDP/53"
else
  warn "Meadow may not be on :53 — check: journalctl -u meadow -n 30"
fi

step "Firewall (UFW)"
apt-get install -y -qq ufw >/dev/null 2>&1 || true
ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow ssh comment 'SSH for admin' >/dev/null
ufw allow 53/udp comment 'DNS' >/dev/null
ufw allow 53/tcp comment 'DNS over TCP' >/dev/null
# API port — only allow from local networks (RFC1918).
ufw allow from 10.0.0.0/8 to any port 3000 comment 'Meadow API (LAN only)' >/dev/null
ufw allow from 172.16.0.0/12 to any port 3000 comment 'Meadow API (LAN only)' >/dev/null
ufw allow from 192.168.0.0/16 to any port 3000 comment 'Meadow API (LAN only)' >/dev/null
ufw --force enable >/dev/null
ok "firewall configured: SSH, DNS, API (LAN only)"

step "Journald log rotation (SD card longevity)"
# Without a cap, journald grows until the SD card fills, after which
# everything writes-to-disk freezes (DB, Meadow state, the lot). 100MB is
# plenty for several days of normal logs and trivially small on a 32GB+
# card. Drop in a config snippet rather than editing the main file so
# OS updates can ship a new default without our change blocking it.
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/meadow-rotation.conf <<'EOF'
[Journal]
# Cap total persistent journal usage at 100MB.
SystemMaxUse=100M
# Keep at least 50MB free on the filesystem at all times.
SystemKeepFree=50M
# Don't write any single file larger than 25MB (so vacuum is granular).
SystemMaxFileSize=25M
EOF
systemctl restart systemd-journald
ok "journald capped at 100MB"

step "Outbound feed connectivity"
# Meadow's intel updater pulls these every 6h. They MUST be reachable
# from the box; if not, blocklists go stale (existing data stays in
# Redis — never empty, but no new threats).
for host in raw.githubusercontent.com urlhaus.abuse.ch phishing.army; do
  if curl -sI --max-time 5 "https://$host/" -o /dev/null; then
    ok "$host reachable"
  else
    warn "$host NOT reachable from this box — intel feeds will fail to refresh"
    warn "(check egress firewalls / DNS — Meadow's own /etc/resolv.conf points at 1.1.1.1)"
  fi
done

step "Swap settings (SD card longevity)"
if [ -f /etc/sysctl.conf ]; then
  if ! grep -q "vm.swappiness" /etc/sysctl.conf; then
    echo "vm.swappiness=10" >> /etc/sysctl.conf
    sysctl -p >/dev/null 2>&1 || true
    ok "set vm.swappiness=10"
  else
    ok "vm.swappiness already configured"
  fi
fi

step "Verifying"
if curl -sf http://localhost:3000/health >/dev/null; then
  ok "Meadow API healthy"
else
  warn "Meadow API not responding — check: journalctl -u meadow -n 50"
fi

# Use dig to actually exercise the DNS path. Test with a known-blocked
# DoH endpoint to verify filtering works.
if command -v dig >/dev/null 2>&1; then
  RESULT=$(dig +short +time=2 +tries=1 cloudflare-dns.com @127.0.0.1 2>/dev/null || true)
  if [ "$RESULT" = "0.0.0.0" ]; then
    ok "DNS filtering verified (cloudflare-dns.com blocked)"
  elif [ -n "$RESULT" ]; then
    warn "DNS responding but cloudflare-dns.com NOT blocked (got: $RESULT)"
    warn "Threat intel may not be loaded yet — wait a minute and re-test"
  else
    warn "DNS not responding — check: journalctl -u meadow -n 50"
  fi
else
  apt-get install -y -qq dnsutils >/dev/null 2>&1
fi

step "Done"
LAN_IP=$(ip -4 addr show | grep -E 'inet (192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))' | head -1 | awk '{print $2}' | cut -d/ -f1)
cat <<EOF

  Pi setup complete.

  ${BOLD}This Pi is now serving DNS on UDP/53.${RESET}
  Point your devices' DNS to: ${BOLD}${LAN_IP:-<find with: ip -4 addr show>}${RESET}

  ${BOLD}Test from another device on your LAN:${RESET}
    dig @${LAN_IP:-<pi-ip>} cloudflare-dns.com   # should return 0.0.0.0 (blocked)
    dig @${LAN_IP:-<pi-ip>} google.com           # should return real IP

  ${BOLD}Logs:${RESET}
    Meadow:   journalctl -u meadow -f
    Firewall: ufw status verbose

EOF
