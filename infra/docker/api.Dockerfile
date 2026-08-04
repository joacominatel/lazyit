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
COPY apps/agent/package.json apps/agent/
COPY packages/shared/package.json packages/shared/
COPY packages/fetch-cli/package.json packages/fetch-cli/
RUN ok=0; for i in 1 2 3; do bun install --frozen-lockfile && ok=1 && break || { echo "bun install failed (attempt $i/3), retrying in 5s..."; sleep 5; }; done; [ "$ok" -eq 1 ]

# Sources needed to build the API (shared is a workspace dependency).
COPY packages/shared/ packages/shared/
COPY apps/api/ apps/api/

RUN bun run --filter @lazyit/shared build
WORKDIR /app/apps/api
RUN bunx prisma generate          # -> apps/api/generated/prisma (compiled into dist/generated)
RUN bun run build                 # nest build -> apps/api/dist/src/main.js (sourceRoot: src)
WORKDIR /app

# ---- Agent binaries: Bun-compile the reporting agent for every target (ADR-0074 §6) ----
# Reuses the builder (it already has bun + the built @lazyit/shared the agent imports for the SAME
# zod contract the API validates — zero drift). Cross-compiles FIVE artifacts and the API serves
# whichever the operator's host needs via GET /agent/download?os=&arch=.
#
# `x64-baseline` is the pre-AVX2 build (#1137): the ordinary x64 target assumes AVX2 (Haswell, 2013),
# so a pre-Haswell host or an EVC-masked vSphere cluster would SIGILL on it. It is built for BOTH
# operating systems because the failure is the hypervisor's, not the OS's — a Windows guest on an EVC
# baseline is in exactly the same position as a Linux one.
#
# WINDOWS ARTIFACTS ARE CROSS-COMPILED HERE, on Linux, and the build stage never runs them. That is
# the same property the arm64 artifact already relied on; `bun build --compile --target=` emits the
# target's executable regardless of the builder's platform. There is no bun-windows-arm64 target,
# which is why the controller refuses that combination by name rather than 404-ing on a missing file.
#
# The compile step also writes a `.sha256` beside each artifact, which GET /agent/checksum publishes
# and install.sh / install.ps1 verify.
# CI's "Build api image" job validates this stage.
FROM builder AS agent-builder
WORKDIR /app

# Version identity for the SHIPPED BINARIES (ADR-0083 §version handshake, #1203). The compile script
# bakes `process.env.APP_VERSION` into each artifact via `bun build --define`, reading the APP_VERSION
# env var and falling back to `git describe --tags --always || echo dev`. This stage must therefore be
# given the SAME build arg the runtime stage gets: a build arg is scoped to the stage that declares it,
# and `.dockerignore` excludes `.git`, so without this ARG every image-built agent stamped itself `dev`
# — which made the "Agent outdated" badge (#907) permanently fail-soft-silent and `agentSkew.agentAhead`
# permanently false. ENV (not just the ARG) so the value is unmistakably in the compile's environment.
# `dev` stays the honest default for a plain `docker build` with no args, exactly as in `runtime`.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

COPY apps/agent/ apps/agent/
# -> apps/agent/dist/lazyit-agent-linux-{x64,x64-baseline,arm64} and
#    apps/agent/dist/lazyit-agent-windows-{x64,x64-baseline}.exe, each with a .sha256 beside it
RUN bun run --filter @lazyit/agent compile

# ---- Prod deps: only the API's production tree, hoisted (flat node_modules) ----
# --filter keeps the lockfile intact (so --production's implicit frozen check passes) while
# excluding the web app's deps; --linker hoisted gives a flat node_modules for plain Node resolution.
# oven/bun:1.3.14
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/agent/package.json apps/agent/
COPY packages/shared/package.json packages/shared/
COPY packages/fetch-cli/package.json packages/fetch-cli/
RUN ok=0; for i in 1 2 3; do bun install --production --linker hoisted --filter "@lazyit/api" && ok=1 && break || { echo "bun install failed (attempt $i/3), retrying in 5s..."; sleep 5; }; done; [ "$ok" -eq 1 ]

# ---- Runtime: minimal Node (Alpine) ----
# node:26-alpine — pinned by digest (26-alpine is a ROLLING tag; this closes the ADR-0025 follow-up).
FROM node:26-alpine@sha256:7c6af15abe4e3de859690e7db171d0d711bf37d27528eddfe625b2fe89e097f8 AS runtime
WORKDIR /app
ENV NODE_ENV=production
# PORT is read by NestJS (main.ts) and by the healthcheck below; compose overrides it.
ENV PORT=3001

# Version identity (ADR-0083): the git tag is the source of truth, injected at build time —
# compose passes APP_VERSION/GIT_SHA from LAZYIT_VERSION/LAZYIT_GIT_SHA (exported by infra/start.sh
# from `git describe --tags --always` / `git rev-parse --short HEAD`). Baked to ENV and surfaced by
# GET /instance/version. A plain `docker build` (no args) honestly reads dev/unknown.
ARG APP_VERSION=dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION}
ENV GIT_SHA=${GIT_SHA}

# Flat production node_modules + the built artifacts. The generated Prisma client is already
# inside dist/generated (tsc emits it next to dist/src). @lazyit/shared resolves via the
# node_modules symlink -> /app/packages/shared (its dist + package.json are copied below).
COPY --from=prod-deps /app/node_modules                ./node_modules
COPY --from=builder   /app/packages/shared/dist        ./packages/shared/dist
COPY --from=builder   /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder   /app/apps/api/dist               ./apps/api/dist
COPY --from=builder   /app/apps/api/package.json       ./apps/api/package.json

# Baked reporting-agent binaries (ADR-0074 §6) — served by GET /agent/download. AGENT_BIN_DIR points
# the controller here; the binaries are streamed, never executed in this container.
#
# The whole dist/ directory rather than a line per artifact (#1137): it now holds five binaries and
# a `.sha256` beside each, and a per-file list is exactly the kind of thing a later target gets added
# to the compile script but not to here — which would ship a binary whose digest 404s, and quietly
# turn the installer's integrity check back off. #1144 added two targets and needed no edit here,
# which is the property working as intended.
ENV AGENT_BIN_DIR=/app/agent/bin
COPY --from=agent-builder /app/apps/agent/dist/ /app/agent/bin/

# Create the attachments blob dir owned by the non-root runtime user (#1019). The named volume
# (attachments_data:/app/attachments) is seeded from this path's ownership on first mount, so the
# node process can mkdir tmp/ and write blobs (ADR-0082). Without this, Docker mounts the volume
# root-owned and every upload 500s with EACCES.
RUN mkdir -p /app/attachments && chown -R node:node /app/attachments

USER node
EXPOSE 3001

# Liveness: probe the dedicated public liveness endpoint. GET /health/live is @Public() (skips the
# global JwtAuthGuard — ADR-0038) and returns 200 when the process is up. Decouples the probe from
# the guard's unauthenticated behavior (a 401-as-health coupling that any future guard change broke).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3001)+'/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "apps/api/dist/src/main"]
