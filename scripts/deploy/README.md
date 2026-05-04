# Meadow Deployment

Scripts to install Meadow on a Linux box (Pi, Ubuntu Server, etc.).

## Files

- **`install.sh`** — generic Debian/Ubuntu installer. Sets up Node, Postgres,
  Redis, system user, repo, env, migrations, and systemd service. Idempotent.
- **`pi-setup.sh`** — Pi-specific add-on. Run after `install.sh`. Sets the
  hostname, configures UFW firewall, installs dnsmasq as DNS frontend,
  tunes swap for SD card longevity.
- **`meadow.service`** — systemd unit. Hardened with the usual Protect*
  directives, runs as the `meadow` system user, restarts on failure.
- **`test-deploy.sh`** — Docker-based smoke test. Validates `install.sh`
  works on a clean Ubuntu image without needing real hardware.

## On a Raspberry Pi

```sh
# Flash Pi OS Lite to an SD card. Boot the Pi, SSH in.
# Then:
git clone https://github.com/duquettelogan/meadow.git
cd meadow
sudo ./scripts/deploy/install.sh
sudo ./scripts/deploy/pi-setup.sh
```

That's it. The Pi is now a Meadow node listening on its LAN IP for DNS
queries on port 53 and serving the API on port 3000.

To use it, point your devices' DNS to the Pi's IP. Find it with:

```sh
ip -4 addr show | grep inet
```

## On any other Debian/Ubuntu machine

Same as above but skip `pi-setup.sh`:

```sh
sudo ./scripts/deploy/install.sh
```

The service runs on port 3000. You'll need to handle DNS forwarding
yourself if you want to use the box as a DNS server.

## Testing without hardware

```sh
./scripts/deploy/test-deploy.sh
```

Spins up Ubuntu 24.04 in Docker, runs `install.sh`, validates the script
completes. Doesn't test systemd-dependent stuff (services don't start in
Docker), but catches the 80% of bugs that are about file paths,
permissions, missing deps, env handling, etc.

## What gets installed where

| Path | Purpose |
|------|---------|
| `/opt/meadow` | Repo checkout, owned by `meadow` user |
| `/etc/meadow/meadow.env` | Generated secrets + config (mode 640, owned by `root:meadow`) |
| `/etc/systemd/system/meadow.service` | Systemd unit |
| Postgres `meadow` DB | Application data |
| Redis (default config) | Cache + blocklists |

## Re-running the installer

`install.sh` is idempotent. Running it again will:

- Skip system packages already installed
- Skip user creation if `meadow` already exists
- Pull the latest commit on the configured branch
- Re-run `npm install` (cheap)
- Skip Postgres user/DB creation if already present
- Leave the existing env file alone (won't overwrite secrets)
- Re-run migrations (they're `CREATE TABLE IF NOT EXISTS`)
- Restart the systemd service

This makes the installer also serve as your update mechanism: re-run it
to deploy a new version.

## Manual operations

```sh
# Logs
journalctl -u meadow -f

# Restart after env change
sudo systemctl restart meadow

# Force a threat intel refresh
sudo -u meadow bash -c 'set -a; source /etc/meadow/meadow.env; set +a; cd /opt/meadow && npx ts-node src/intel/refresh.ts'

# Smoke test
curl http://localhost:3000/health
```

## Security notes

The installer:

- Generates strong (32-byte) random JWT and HMAC secrets
- Generates a random 24-byte Postgres password
- Stores them in `/etc/meadow/meadow.env` with mode 640 (root + meadow group only)
- Runs the service as a dedicated unprivileged `meadow` user
- Applies systemd hardening (NoNewPrivileges, ProtectSystem=strict, etc.)
- Configures UFW (in `pi-setup.sh`) to block everything except SSH, DNS,
  and API-from-LAN

What it does NOT do (yet):

- Install TLS (the API speaks plain HTTP — fine for LAN, not for public
  internet)
- Set up automatic OS security updates (Pi OS has unattended-upgrades
  available — add later)
- Configure log rotation beyond systemd defaults
- Install fail2ban
