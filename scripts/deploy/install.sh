#!/usr/bin/env bash
# Meadow installer.
#
# Sets up Meadow on a Debian-based Linux system (Pi OS Lite, Ubuntu Server,
# Pop!OS, etc.). Idempotent — safe to re-run.
#
# Two install modes:
#
#   box  (default on a Raspberry Pi)
#       The on-prem device. NO Postgres. Filter policy comes from the
#       cloud API; block events go back via the cloud API. Keeps
#       Redis (for the local intel blocklist + box context cache),
#       dnsmasq + avahi for the LAN handoff, and the Meadow service.
#       meadow.env gets MEADOW_MODE=box and DATABASE_URL is omitted.
#
#   api  (default everywhere else)
#       The cloud API server. Postgres + Redis + Meadow service +
#       migrations. The path historically taken by this script.
#       Note: production runs on Fly.io and uses the Dockerfile, not
#       this installer; this is for self-hosters / dev VMs.
#
# Detection order:
#   1. MEADOW_INSTALL_MODE env var (`box` or `api`) — wins.
#   2. /sys/firmware/devicetree/base/model exists → box (Pi marker).
#   3. Otherwise → api.
#
# Usage:
#   sudo ./install.sh                            # auto-detect mode
#   sudo MEADOW_INSTALL_MODE=box ./install.sh    # force box
#   sudo MEADOW_INSTALL_MODE=api ./install.sh    # force api
#   sudo REPO_URL=... ./install.sh               # use a different repo
#   sudo REPO_REF=branchname ./install.sh        # use a different branch/tag
#
# Tested on:
#   - Pi OS Lite (Bookworm, ARM64)
#   - Ubuntu Server 24.04
#   - Pop!OS 22.04 (dev)

set -euo pipefail

# ---------- Config ----------
REPO_URL="${REPO_URL:-https://github.com/duquettelogan/meadow.git}"
REPO_REF="${REPO_REF:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/meadow}"
ENV_DIR="${ENV_DIR:-/etc/meadow}"
ENV_FILE="${ENV_DIR}/meadow.env"
BOOTSTRAP_FILE="${ENV_DIR}/bootstrap.env"
API_URL="${API_URL:-https://api.meadow.dqsec.com}"
SYSTEM_USER="${SYSTEM_USER:-meadow}"
DB_NAME="${DB_NAME:-meadow}"
DB_USER="${DB_USER:-meadow}"
SERVICE_NAME="meadow"

# ---------- Helpers ----------
RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'

step()  { printf "\n${BOLD}==> %s${RESET}\n" "$1"; }
ok()    { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn()  { printf "  ${YELLOW}!${RESET} %s\n" "$1"; }
die()   { printf "  ${RED}✗ %s${RESET}\n" "$1" >&2; exit 1; }

require_root() {
  [ "$EUID" -eq 0 ] || die "must be run as root (use sudo)"
}

# ---------- Steps ----------

require_root

step "Detecting system"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  ok "OS: ${PRETTY_NAME:-unknown}"
else
  die "/etc/os-release not found — unsupported system"
fi

ARCH=$(uname -m)
ok "arch: $ARCH"

# Resolve install mode. Explicit env var wins; otherwise auto-detect:
# /sys/firmware/devicetree/base/model exists on every Raspberry Pi.
if [ -n "${MEADOW_INSTALL_MODE:-}" ]; then
  case "$MEADOW_INSTALL_MODE" in
    box|api) MODE="$MEADOW_INSTALL_MODE" ;;
    *)       die "MEADOW_INSTALL_MODE must be 'box' or 'api', got '$MEADOW_INSTALL_MODE'" ;;
  esac
elif [ -f /sys/firmware/devicetree/base/model ]; then
  MODE=box
else
  MODE=api
fi
ok "install mode: $MODE"

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git build-essential \
  postgresql postgresql-contrib redis-server \
  ufw \
  avahi-daemon avahi-utils \
  dnsmasq \
  sudo \
  >/dev/null
ok "base packages installed (incl. avahi for meadow.local + dnsmasq for DHCP handoff)"

# Avahi advertises the box's hostname (set by pi-setup.sh = 'meadow')
# as meadow.local on the LAN, so the parent's phone can hit
# http://meadow.local during the box-originated pairing flow.
systemctl enable -q avahi-daemon 2>/dev/null || true
systemctl start avahi-daemon 2>/dev/null || true

# dnsmasq must NOT auto-start at boot. Bootstrap runs the 30s DHCP
# conflict check first, then writes /etc/dnsmasq.d/meadow.conf and
# starts dnsmasq itself only if no conflict is detected.
systemctl stop dnsmasq 2>/dev/null || true
systemctl disable dnsmasq 2>/dev/null || true

# Node 20 LTS via NodeSource (Pi OS apt has older versions)
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  step "Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  ok "Node $(node -v) installed"
else
  ok "Node $(node -v) already installed"
fi

step "Creating system user"
if id -u "$SYSTEM_USER" >/dev/null 2>&1; then
  ok "user $SYSTEM_USER already exists"
else
  useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$SYSTEM_USER"
  ok "created user $SYSTEM_USER"
fi

step "Cloning / updating repo"
if [ ! -d "$INSTALL_DIR/.git" ]; then
  mkdir -p "$INSTALL_DIR"
  git clone --branch "$REPO_REF" --depth 1 "$REPO_URL" "$INSTALL_DIR"
  ok "cloned $REPO_URL @ $REPO_REF"
else
  cd "$INSTALL_DIR"
  git fetch --depth 1 origin "$REPO_REF"
  git checkout -q "$REPO_REF"
  git reset --hard "origin/$REPO_REF"
  ok "updated to latest $REPO_REF"
fi
chown -R "$SYSTEM_USER:$SYSTEM_USER" "$INSTALL_DIR"

step "Installing npm dependencies"
cd "$INSTALL_DIR"
sudo -u "$SYSTEM_USER" npm ci --silent --omit=dev >/dev/null 2>&1 || \
  sudo -u "$SYSTEM_USER" npm install --silent --omit=dev >/dev/null 2>&1
# We use ts-node to run TS directly on the Pi for now. Eventually we'll
# build to JS in CI and ship just dist/.
sudo -u "$SYSTEM_USER" npm install --silent ts-node typescript >/dev/null 2>&1
ok "npm deps installed"

if [ "$MODE" = "api" ]; then
  step "Setting up Postgres"
  systemctl start postgresql
  systemctl enable -q postgresql

  # Idempotent role + database creation.
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    DB_PASS=$(openssl rand -hex 24)
    sudo -u postgres psql -q -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
    ok "created postgres user $DB_USER"
  else
    ok "postgres user $DB_USER already exists"
    # Re-read password from existing env file later if needed.
    DB_PASS=""
  fi

  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
    sudo -u postgres psql -q -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
    ok "created database $DB_NAME"
  else
    ok "database $DB_NAME already exists"
  fi
else
  step "Postgres setup"
  ok "skipped (box mode talks to the cloud API instead)"
fi

step "Setting up Redis"
systemctl start redis-server
systemctl enable -q redis-server
ok "redis running"

step "Setting up state directories"
# /etc/meadow holds box.env (api key) — root-owned, meadow group
# can read.
# /var/lib/meadow holds the pairing-code generated at first boot —
# meadow user owns it so the unprivileged bootstrap can write.
mkdir -p /var/lib/meadow
chown "$SYSTEM_USER:$SYSTEM_USER" /var/lib/meadow
chmod 700 /var/lib/meadow

step "Setting up dnsmasq drop-in for Meadow"
# Drop-in conf so bootstrap can rewrite the DHCP scope without touching
# the system /etc/dnsmasq.conf. dnsmasq reads /etc/dnsmasq.d/*.conf
# automatically. The file is meadow-owned so the unprivileged
# bootstrap process can re-render it on each network setup run.
mkdir -p /etc/dnsmasq.d
touch /etc/dnsmasq.d/meadow.conf
chown "$SYSTEM_USER:$SYSTEM_USER" /etc/dnsmasq.d/meadow.conf
chmod 644 /etc/dnsmasq.d/meadow.conf
ok "/etc/dnsmasq.d/meadow.conf prepared (writable by $SYSTEM_USER)"

# Sudoers rule: the unprivileged meadow user needs to (re)start
# dnsmasq after writing the conf. NOPASSWD scoped to ONLY the three
# systemctl verbs we actually use, so a compromise of the meadow
# user can't escalate to arbitrary root.
SUDOERS_FILE=/etc/sudoers.d/meadow
cat > "$SUDOERS_FILE" <<EOF
# Generated by meadow install.sh — managed file.
# Lets the unprivileged meadow user manage just dnsmasq.
$SYSTEM_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart dnsmasq, /usr/bin/systemctl start dnsmasq, /usr/bin/systemctl stop dnsmasq, /usr/bin/systemctl restart meadow-bootstrap.service
EOF
chmod 440 "$SUDOERS_FILE"
chown root:root "$SUDOERS_FILE"
# Validate before sudoers picks it up — a typo here could lock
# everyone out of sudo.
if visudo -cf "$SUDOERS_FILE" >/dev/null 2>&1; then
  ok "sudoers rule for dnsmasq installed"
else
  warn "sudoers fragment $SUDOERS_FILE failed validation; removing"
  rm -f "$SUDOERS_FILE"
fi

step "Setting up environment file"
mkdir -p "$ENV_DIR"
# 0700 owned by the meadow user — bootstrap (running unprivileged)
# needs to create $ENV_DIR/box.env.tmp during the atomic write-and-
# rename in src/box/bootstrap.ts writeBoxEnv(). Previously root:root
# 0750 which blocked the tmp-file create (EACCES). The directory
# holding mk_… secrets shouldn't be group-readable anyway.
chown "$SYSTEM_USER:$SYSTEM_USER" "$ENV_DIR"
chmod 0700 "$ENV_DIR"

if [ ! -f "$ENV_FILE" ]; then
  # Fresh install — generate everything.
  if [ "$MODE" = "api" ] && [ -z "$DB_PASS" ]; then
    # Postgres user already existed without a tracked password — reset it.
    DB_PASS=$(openssl rand -hex 24)
    sudo -u postgres psql -q -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
    warn "reset $DB_USER password (existing user, no env file)"
  fi

  JWT_SECRET=$(openssl rand -hex 32)
  HMAC_SECRET=$(openssl rand -hex 32)

  if [ "$MODE" = "api" ]; then
    cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -Iseconds) (mode=api)
# Restart the service after changing values: systemctl restart $SERVICE_NAME

MEADOW_MODE=api

DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
REDIS_URL=redis://localhost:6379

JWT_SECRET=$JWT_SECRET
API_KEY_HMAC_SECRET=$HMAC_SECRET

# External API keys — set these manually if you have them.
CLOUDFLARE_API_TOKEN=
CLOUDFLARE_ACCOUNT_ID=
OPENAI_API_KEY=

PORT=3000
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:3001
EOF
  else
    # Box mode — no DATABASE_URL, no JWT/HMAC secrets (those are
    # cloud-side concerns). API_URL points at the cloud.
    cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -Iseconds) (mode=box)
# Restart the service after changing values: systemctl restart $SERVICE_NAME

MEADOW_MODE=box

# Where the box phones home. The bootstrap also reads API_URL from
# $BOOTSTRAP_FILE; this entry keeps the runtime process consistent.
API_URL=$API_URL

REDIS_URL=redis://localhost:6379

PORT=3000
EOF
  fi
  chmod 640 "$ENV_FILE"
  chown root:"$SYSTEM_USER" "$ENV_FILE"
  ok "wrote $ENV_FILE (mode=$MODE)"
else
  ok "$ENV_FILE already exists, leaving it alone"
fi

step "Setting up box bootstrap config"
if [ ! -f "$BOOTSTRAP_FILE" ]; then
  cat > "$BOOTSTRAP_FILE" <<EOF
# Generated by install.sh on $(date -Iseconds)
# Box client config — where the Pi phones home.
API_URL=$API_URL
EOF
  chmod 640 "$BOOTSTRAP_FILE"
  chown root:"$SYSTEM_USER" "$BOOTSTRAP_FILE"
  ok "wrote $BOOTSTRAP_FILE (API_URL=$API_URL)"
else
  ok "$BOOTSTRAP_FILE already exists, leaving it alone"
fi

if [ "$MODE" = "api" ]; then
  step "Running database migrations"
  cd "$INSTALL_DIR"
  sudo -u "$SYSTEM_USER" --preserve-env=PATH \
    bash -c "set -a; source $ENV_FILE; set +a; npx ts-node scripts/run-migrations.ts" \
    >/dev/null
  ok "migrations applied"
else
  step "Database migrations"
  ok "skipped (box mode — schema lives on the cloud API)"
fi

step "Installing systemd services"
SCRIPT_DIR="$( cd -- "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd )"

# meadow.service Requires meadow-bootstrap.service, so both unit
# files must land in /etc/systemd/system. Previously only the main
# unit was copied → `Unit meadow-bootstrap.service not found.`
install_unit() {
  local unit="$1"
  local dest="/etc/systemd/system/${unit}"
  if [ -f "$SCRIPT_DIR/${unit}" ]; then
    cp "$SCRIPT_DIR/${unit}" "$dest"
  elif [ -f "$INSTALL_DIR/scripts/deploy/${unit}" ]; then
    cp "$INSTALL_DIR/scripts/deploy/${unit}" "$dest"
  else
    die "${unit} file not found"
  fi
  chmod 644 "$dest"
}

install_unit "meadow-bootstrap.service"
install_unit "meadow.service"
systemctl daemon-reload
# Enable bootstrap first (meadow Requires + After it). enable only
# wires up next-boot; start is what we use to bring units up now.
systemctl enable -q meadow-bootstrap.service
systemctl enable -q "$SERVICE_NAME"

if [ "$MODE" = "box" ]; then
  # Box mode: meadow-bootstrap is Type=oneshot whose ExecStart pairs
  # the box with the cloud. Pairing depends on the operator opening
  # the dashboard and entering the code shown on meadow.local — could
  # take seconds, could take an hour. Never block install.sh on it.
  # `systemctl start --no-block` enqueues the job and returns
  # immediately; bootstrap runs in the background, meadow.service
  # auto-starts via Requires/After the moment bootstrap reaches active.
  systemctl start --no-block meadow-bootstrap.service
  ok "meadow-bootstrap.service kicked off in the background"
  ok "(meadow.service auto-starts once bootstrap finishes pairing)"
else
  # API mode: no human-in-the-loop dependency. Synchronous restart +
  # wait for /health is the right shape.
  systemctl restart "$SERVICE_NAME"
  ok "$SERVICE_NAME installed and started"

  step "Waiting for service to come up"
  for i in $(seq 1 30); do
    if curl -sf http://localhost:3000/health >/dev/null 2>&1; then
      ok "service is healthy"
      break
    fi
    if [ "$i" = "30" ]; then
      warn "service did not respond on /health — check logs:"
      warn "  journalctl -u $SERVICE_NAME -n 50"
      exit 1
    fi
    sleep 1
  done
fi

step "Done"
cat <<EOF

  Meadow is running.

  ${BOLD}Service:${RESET}    systemctl status $SERVICE_NAME
  ${BOLD}Logs:${RESET}       journalctl -u $SERVICE_NAME -f
  ${BOLD}Health:${RESET}     curl http://localhost:3000/health
  ${BOLD}Config:${RESET}     $ENV_FILE
  ${BOLD}Code:${RESET}       $INSTALL_DIR

  Next steps:
    - If this is a Pi, run pi-setup.sh next for hostname + firewall + DNS.
    - Add CLOUDFLARE_API_TOKEN, OPENAI_API_KEY to $ENV_FILE if you have them,
      then: systemctl restart $SERVICE_NAME

EOF
