## Multi-stage build for the Meadow API server.
##
## Used by Fly.io deploys (and any other container target). The Pi box
## runs from source via ts-node + systemd — see scripts/deploy/install.sh.
## This image is API-only; the UDP DNS server is gated by DNS_PORT=0
## in the Fly env so it never tries to bind :53 in the cloud.

FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Install deps with cache layer.
COPY package.json package-lock.json* ./
RUN npm ci

# Build TypeScript to dist/.
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- runtime ----------
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
# DNS server stays off in the cloud — only the home box binds :53.
ENV DNS_PORT=0

# Production deps only.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Static data shipped with the API image:
#   data/oui.txt — IEEE OUI prefixes for src/box/oui.ts. The path is
#   resolved relative to dist/box/__dirname (../../data/oui.txt → /app/data/oui.txt).
#   Without this COPY the box-discover loop logs ENOENT on every tick.
COPY data ./data

# Run as a non-root user. Built-in `node` user (uid 1000) is fine.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/health',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
