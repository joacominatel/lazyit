# syntax=docker/dockerfile:1
#
# lazyit Web image — Next.js 16 standalone server on Node, built with Bun.
# Build from the repo ROOT:  docker build -f infra/docker/web.Dockerfile -t lazyit-web:dev .
# Rationale: ADR-0025 (standalone output) + ADR-0026 (NEXT_PUBLIC_API_URL=/api -> domain-portable).

# Base images are digest-pinned (@sha256) for reproducibility (ADR-0025 follow-up); human tag kept
# in the comment. Re-pin: docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'.

# ---- Builder: Bun (Debian) builds @lazyit/shared then the Next.js standalone bundle ----
# oven/bun:1.3.14
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder
WORKDIR /app

# NEXT_PUBLIC_* is inlined at BUILD time. Default "/api" makes the image domain-portable:
# the browser calls /api/* same-origin and Caddy routes it to the API (ADR-0026).
ARG NEXT_PUBLIC_API_URL=/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN ok=0; for i in 1 2 3; do bun install --frozen-lockfile && ok=1 && break || { echo "bun install failed (attempt $i/3), retrying in 5s..."; sleep 5; }; done; [ "$ok" -eq 1 ]

COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN bun run --filter @lazyit/shared build
RUN bun run --filter @lazyit/web build      # next build -> apps/web/.next (standalone)

# ---- Runtime: minimal Node (Alpine), runs the standalone server ----
# node:26-alpine — pinned by digest (26-alpine is a ROLLING tag; this closes the ADR-0025 follow-up).
FROM node:26-alpine@sha256:a2dc166a387cc6ca1e62d0c8e265e49ca985d6e60abc9fe6e6c3d6ce8e63f606 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Next standalone server reads HOSTNAME/PORT; bind all interfaces so Caddy can reach it.
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# Standalone output already contains a traced, minimal node_modules. In this monorepo the
# server entry lands at apps/web/server.js; static assets and public/ are copied alongside it.
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static     ./apps/web/.next/static
COPY --from=builder /app/apps/web/public           ./apps/web/public

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]
