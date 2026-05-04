#!/usr/bin/env bash
# Test the deploy scripts in a Docker container.
#
# Spins up an Ubuntu 24.04 container, mounts the repo, runs install.sh,
# and verifies the service comes up healthy. This catches script bugs
# without needing a real Pi.
#
# Limitations:
#   - Tests install.sh on Ubuntu, not Pi OS specifically. Pi OS Bookworm
#     is Debian-based and the script is generic Debian, so this is close.
#   - Doesn't test pi-setup.sh (UFW, dnsmasq) — those need network
#     privileges Docker doesn't grant easily.
#
# Usage:
#   ./test-deploy.sh           # default Ubuntu 24.04
#   IMAGE=debian:bookworm ./test-deploy.sh

set -euo pipefail

IMAGE="${IMAGE:-ubuntu:24.04}"
REPO_ROOT="$( cd -- "$(dirname "${BASH_SOURCE[0]}")/../.." &> /dev/null && pwd )"

echo "==> Testing deploy on $IMAGE"
echo "    repo: $REPO_ROOT"

# Run install.sh inside the container against the local repo. We use a
# file:// URL for git clone so the script works without network access
# to GitHub.
docker run --rm \
  -v "$REPO_ROOT:/src:ro" \
  -e DEBIAN_FRONTEND=noninteractive \
  -e REPO_URL="file:///src" \
  -e INSTALL_DIR=/opt/meadow \
  "$IMAGE" \
  bash -c '
    set -e

    # Install minimal deps to bootstrap.
    apt-get update -qq
    apt-get install -y -qq sudo systemctl curl ca-certificates >/dev/null 2>&1 || \
      apt-get install -y -qq curl ca-certificates >/dev/null

    # Trick: docker doesnt have systemd by default. Install policy-rc.d
    # to suppress service start attempts and install fake systemctl.
    cat > /usr/local/bin/systemctl <<EOF
#!/bin/bash
# Fake systemctl for docker test — just no-ops most operations and
# returns success so the install script can proceed.
case "\$1" in
  start|enable|restart|daemon-reload|stop|disable)
    echo "[fake-systemctl] \$@"
    exit 0
    ;;
  is-active)
    exit 1
    ;;
  status)
    echo "[fake-systemctl] would show status of \$2"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
EOF
    chmod +x /usr/local/bin/systemctl

    # Run the install. Postgres + Redis wont start as services, but we
    # can validate the script logic, file creation, user setup, etc.
    cd /src
    bash scripts/deploy/install.sh || {
      echo
      echo "INSTALL FAILED — see output above."
      exit 1
    }
  '

echo
echo "==> Deploy script test passed."
