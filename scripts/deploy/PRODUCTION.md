# Production Deploy

This file covers two distinct deployments:

1. **Cloud API server (Fly.io)** — the database-backed REST surface
   that the dashboard talks to and that home boxes phone into.
   Single instance, single source of truth.

2. **Box (Raspberry Pi)** — the on-prem device that runs the LAN's
   DNS filter. NO Postgres. Pulls policy from the cloud API on a
   timer; pushes block events back via the cloud API. Provisioned
   via `scripts/deploy/install.sh` with `MEADOW_INSTALL_MODE=box`
   (auto-detected on a Pi via `/sys/firmware/devicetree/base/model`).

Skip to "Pi box install" below for #2.

# Cloud API (Fly.io)

End-to-end checklist for putting the Meadow API on the public internet
so home boxes can phone in. Logan: do not skip the secret generation
step. Do not reuse dev values.

## One-time setup

```sh
# 1. Install Fly CLI and log in.
brew install flyctl   # macOS
# or: curl -L https://fly.io/install.sh | sh
fly auth signup       # or: fly auth login

# 2. Create the app (it'll read fly.toml). The first run picks a unique
#    name — accept the suggestion or pass --name to override.
fly launch --no-deploy

# 3. Provision Postgres. Pick a region close to you (PCS-to-Japan-aware:
#    Logan should put this in Tokyo or Singapore for low latency once
#    he's there; ORD/SJC works for now).
fly postgres create --name meadow-prod-db --region ord
fly postgres attach meadow-prod-db

# Fly sets DATABASE_URL automatically after attach. Verify:
fly secrets list

# 4. Provision Redis. Upstash add-on (TLS by default).
fly redis create --name meadow-prod-cache
# Pull the rediss:// URL from the output; set it as a secret:
fly secrets set REDIS_URL='rediss://...'

# 5. Generate fresh secrets — NEVER reuse dev values.
fly secrets set \
  JWT_SECRET=$(openssl rand -hex 32) \
  API_KEY_HMAC_SECRET=$(openssl rand -hex 32) \
  ALLOWED_ORIGINS=https://meadow.dqsec.com,https://app.meadow.dqsec.com \
  BOX_VERSION=1.0.0

# 6. Deploy.
fly deploy

# 7. Run migrations against prod (one-shot job).
fly ssh console -C 'node /app/dist/db/migrate.js'   # or run via ts-node
# Repeat for migrate-002 through migrate-005.
```

## DNS / TLS

Fly handles TLS automatically once you map a hostname.

```sh
fly certs add api.meadow.dqsec.com
# Then add the CNAME / A records Fly tells you to add. After the cert
# issues (60-120s usually), the API answers at https://api.meadow.dqsec.com.
```

Box bootstrap reads `API_URL` env (default localhost:3000). On the
prod-baked Pi image, set `API_URL=https://api.meadow.dqsec.com` in
`/etc/meadow/bootstrap.env` before flashing.

## Cloudflare in front

Strongly recommended for DDoS protection, rate-limiting, and bot
filtering. Put the Fly app behind Cloudflare in DNS-only mode (orange
cloud OFF) initially so you can debug TLS, then proxy on (orange cloud
ON) once it's stable.

## Secret rotation

```sh
# Generate new value, set it, redeploy (Fly does rolling restart).
NEW=$(openssl rand -hex 32)
fly secrets set JWT_SECRET=$NEW
# Note: rotating JWT_SECRET invalidates all parent sessions instantly.
# Rotating API_KEY_HMAC_SECRET breaks every paired box until they
# re-pair. Treat both as last-resort actions.
```

## Backups

```sh
# Manual snapshot.
fly postgres backup create -a meadow-prod-db

# List + restore.
fly postgres backup list -a meadow-prod-db
fly postgres backup restore <id> -a meadow-prod-db
```

Daily backups are on by default for Fly Postgres. Test the restore
procedure into a scratch DB before you trust it.

## Monitoring

```sh
fly logs                # tail logs
fly status              # health + machine count
fly checks list         # health-check history
```

Hook the /health endpoint into Better Stack / Cronitor / your monitor of
choice for paging when the app goes down.

# Pi box install

The Pi runs in **box mode** — no Postgres, all policy / block-counter
data flows through the cloud API. `install.sh` auto-detects a Pi via
`/sys/firmware/devicetree/base/model` and skips the Postgres install +
migrations + secret generation entirely.

```sh
# Fresh Pi OS Lite (Bookworm 64-bit), wired to the LAN, ssh enabled.
sudo apt-get update && sudo apt-get install -y curl git
git clone https://github.com/duquettelogan/meadow.git /tmp/meadow
sudo API_URL=https://api.meadow.dqsec.com /tmp/meadow/scripts/deploy/install.sh
```

What that does:
- Installs Node 20, Redis, dnsmasq, avahi, the meadow systemd unit.
- Writes `/etc/meadow/meadow.env` with `MEADOW_MODE=box` and
  `API_URL=$API_URL`. **No DATABASE_URL** (box doesn't need it).
- Skips `npx ts-node scripts/run-migrations.ts` — the cloud API
  owns the schema.
- Starts the meadow service.

After install:

```sh
sudo /tmp/meadow/scripts/deploy/pi-setup.sh    # hostname=meadow + UFW
```

Pairing — the box's bootstrap (in `src/box/bootstrap.ts`) generates
an 8-digit code and exposes it via the on-LAN web page at
`http://meadow.local`. The parent enters it in the dashboard's
"claim by code" UI; the box polls `/api/v1/pairing/box-status/:hw_id`
until the cloud reveals the api_key.

Forcing a mode:

```sh
sudo MEADOW_INSTALL_MODE=box sudo ./install.sh   # explicit box (e.g. dev VM)
sudo MEADOW_INSTALL_MODE=api sudo ./install.sh   # explicit api (self-host)
```
