# Production Deploy (Fly.io)

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
