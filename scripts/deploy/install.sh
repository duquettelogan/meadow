#!/usr/bin/env bash
# Meadow installer.
#
# Sets up Meadow on a Debian-based Linux system (Pi OS Lite, Ubuntu Server,
# Pop!OS, etc.). Idempotent — safe to re-run.
#
# What it does:
#   1. Installs system deps (Node 20, Postgres, Redis, build tools)
#   2. Creates dedicated `meadow` system user
#   3. Clones (or updates) the repo into /opt/meadow
#   4. Sets up Postgres user + database
#   5. Generates strong secrets in /etc/meadow/meadow.env
#   6. Runs migrations
#   7. Installs and starts systemd service
#   8. Verifies /health endpoint
#
# Usage:
#   sudo ./install.sh                     # default: clone from main repo
#   sudo REPO_URL=... ./install.sh        # use a different repo
#   sudo REPO_REF=branchname ./install.sh # use a different branch/tag
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

step "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git build-essential \
  postgresql postgresql-contrib redis-server \
  ufw \
  >/dev/null
ok "base packages installed"

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

step "Setting up Redis"
systemctl start redis-server
systemctl enable -q redis-server
ok "redis running"

step "Setting up environment file"
mkdir -p "$ENV_DIR"
chmod 750 "$ENV_DIR"

if [ ! -f "$ENV_FILE" ]; then
  # Fresh install — generate everything.
  if [ -z "$DB_PASS" ]; then
    # Postgres user already existed without a tracked password — reset it.
    DB_PASS=$(openssl rand -hex 24)
    sudo -u postgres psql -q -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
    warn "reset $DB_USER password (existing user, no env file)"
  fi

  JWT_SECRET=$(openssl rand -hex 32)
  HMAC_SECRET=$(openssl rand -hex 32)

  cat > "$ENV_FILE" <<EOF
# Generated by install.sh on $(date -Iseconds)
# Restart the service after changing values: systemctl restart $SERVICE_NAME

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
  chmod 640 "$ENV_FILE"
  chown root:"$SYSTEM_USER" "$ENV_FILE"
  ok "wrote $ENV_FILE with generated secrets"
else
  ok "$ENV_FILE already exists, leaving it alone"
fi

step "Running database migrations"
cd "$INSTALL_DIR"
for m in migrate.ts migrate-002.ts migrate-003.ts migrate-004.ts migrate-005.ts migrate-006.ts; do
  sudo -u "$SYSTEM_USER" --preserve-env=PATH \
    bash -c "set -a; source $ENV_FILE; set +a; npx ts-node src/db/$m" \
    >/dev/null
done
ok "migrations applied"

step "Installing systemd service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$( cd -- "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd )"

if [ -f "$SCRIPT_DIR/meadow.service" ]; then
  cp "$SCRIPT_DIR/meadow.service" "$SERVICE_PATH"
elif [ -f "$INSTALL_DIR/scripts/deploy/meadow.service" ]; then
  cp "$INSTALL_DIR/scripts/deploy/meadow.service" "$SERVICE_PATH"
else
  die "meadow.service file not found"
fi
chmod 644 "$SERVICE_PATH"
systemctl daemon-reload
systemctl enable -q "$SERVICE_NAME"
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
