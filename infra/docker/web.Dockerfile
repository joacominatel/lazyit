# syntax=docker/dockerfile:1
#
# lazyit Web image — Next.js 16 standalone server on Node, built with Bun.
# Build from the repo ROOT:  docker build -f infra/docker/web.Dockerfile -t lazyit-web:dev .
# Rationale: ADR-0025 (standalone output) + ADR-0026 (NEXT_PUBLIC_API_URL=/api -> domain-portable).

# ---- Builder: Bun (Debian) builds @lazyit/shared then the Next.js standalone bundle ----
FROM oven/bun:1.3.14 AS builder
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
RUN bun install --frozen-lockfile

COPY packages/shared/ packages/shared/
COPY apps/web/ apps/web/

RUN bun run --filter @lazyit/shared build
RUN bun run --filter @lazyit/web build      # next build -> apps/web/.next (standalone)

# ---- Runtime: minimal Node (Alpine), runs the standalone server ----
FROM node:26-alpine AS runtime
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
