# syntax=docker/dockerfile:1
#
# lazyit API image — NestJS 11 on Node, built with Bun.
# Build from the repo ROOT:  docker build -f infra/docker/api.Dockerfile -t lazyit-api:dev .
# Rationale: ADR-0025 (Bun builder -> Node runtime; Prisma driver-adapter = no engine binary).

# Base images are digest-pinned (@sha256) so the build is reproducible and a re-pulled tag can't
# change underneath us (ADR-0025 follow-up). The human tag is kept in the comment; re-pin after a
# deliberate bump with: docker buildx imagetools inspect <image>:<tag> --format '{{.Manifest.Digest}}'.

# ---- Builder: Bun builds @lazyit/shared, generates the Prisma client, builds the API ----
# oven/bun:1.3.14
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder
WORKDIR /app

# All workspace manifests + lockfile first, so the install layer is cached until they change.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN ok=0; for i in 1 2 3; do bun install --frozen-lockfile && ok=1 && break || { echo "bun install failed (attempt $i/3), retrying in 5s..."; sleep 5; }; done; [ "$ok" -eq 1 ]

# Sources needed to build the API (shared is a workspace dependency).
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

RUN bun run --filter @lazyit/shared build
WORKDIR /app/apps/api
RUN bunx prisma generate          # -> apps/api/generated/prisma (compiled into dist/generated)
RUN bun run build                 # nest build -> apps/api/dist/src/main.js (sourceRoot: src)
WORKDIR /app

# ---- Prod deps: only the API's production tree, hoisted (flat node_modules) ----
# --filter keeps the lockfile intact (so --production's implicit frozen check passes) while
# excluding the web app's deps; --linker hoisted gives a flat node_modules for plain Node resolution.
# oven/bun:1.3.14
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN ok=0; for i in 1 2 3; do bun install --production --linker hoisted --filter "@lazyit/api" && ok=1 && break || { echo "bun install failed (attempt $i/3), retrying in 5s..."; sleep 5; }; done; [ "$ok" -eq 1 ]

# ---- Runtime: minimal Node (Alpine) ----
# node:26-alpine — pinned by digest (26-alpine is a ROLLING tag; this closes the ADR-0025 follow-up).
FROM node:26-alpine@sha256:a2dc166a387cc6ca1e62d0c8e265e49ca985d6e60abc9fe6e6c3d6ce8e63f606 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# PORT is read by NestJS (main.ts) and by the healthcheck below; compose overrides it.
ENV PORT=3001

# Flat production node_modules + the built artifacts. The generated Prisma client is already
# inside dist/generated (tsc emits it next to dist/src). @lazyit/shared resolves via the
# node_modules symlink -> /app/packages/shared (its dist + package.json are copied below).
COPY --from=prod-deps /app/node_modules                ./node_modules
COPY --from=builder   /app/packages/shared/dist        ./packages/shared/dist
COPY --from=builder   /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder   /app/apps/api/dist               ./apps/api/dist
COPY --from=builder   /app/apps/api/package.json       ./apps/api/package.json

USER node
EXPOSE 3001

# Liveness: probe the dedicated public liveness endpoint. GET /health/live is @Public() (skips the
# global JwtAuthGuard — ADR-0038) and returns 200 when the process is up. Decouples the probe from
# the guard's unauthenticated behavior (a 401-as-health coupling that any future guard change broke).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/api/dist/src/main"]
