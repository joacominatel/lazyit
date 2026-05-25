# syntax=docker/dockerfile:1
#
# lazyit API image — NestJS 11 on Node, built with Bun.
# Build from the repo ROOT:  docker build -f infra/docker/api.Dockerfile -t lazyit-api:dev .
# Rationale: ADR-0025 (Bun builder -> Node runtime; Prisma driver-adapter = no engine binary).

# ---- Builder: Bun builds @lazyit/shared, generates the Prisma client, builds the API ----
FROM oven/bun:1.3.14 AS builder
WORKDIR /app

# All workspace manifests + lockfile first, so the install layer is cached until they change.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile

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
FROM oven/bun:1.3.14 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --production --linker hoisted --filter "@lazyit/api"

# ---- Runtime: minimal Node (Alpine) ----
FROM node:26-alpine AS runtime
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

# Liveness: the API answers GET / ("Hello World!") without touching the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/',r=>process.exit(r.statusCode<400?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/api/dist/src/main"]
