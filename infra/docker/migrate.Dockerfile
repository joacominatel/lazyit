# syntax=docker/dockerfile:1
#
# lazyit migrate+seed job — one-shot container, run before the API starts.
# Build from the repo ROOT:  docker build -f infra/docker/migrate.Dockerfile -t lazyit-migrate:dev .
# Rationale: ADR-0025. Runs on Bun (the seed is `bun prisma/seed.ts`); Debian/glibc so the
# Prisma schema engine used by `migrate deploy` finds its binary (avoids the Alpine/musl pitfall).

# oven/bun:1.3.14 — pinned by digest (ADR-0025 follow-up). Re-pin after a deliberate bump:
# docker buildx imagetools inspect oven/bun:1.3.14 --format '{{.Manifest.Digest}}'.
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime
WORKDIR /app

# Manifests + install. --filter scopes to the API (the Prisma CLI is one of its devDependencies,
# so no --production here) and excludes the web app's deps; --linker hoisted keeps it flat.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --linker hoisted --filter "@lazyit/api"

# Prisma schema, migrations history, config and seed (seed.ts imports the generated client only).
COPY apps/api/prisma/        apps/api/prisma/
COPY apps/api/prisma.config.ts apps/api/

# The TS sources for the standalone reindex script (apps/api/scripts/reindex-all.ts). It imports
# src/search/search.documents (pure projectors) + the generated client; @prisma/adapter-pg and
# meilisearch are already installed above. The Node API runtime image has no Bun, so reindex runs
# in THIS Bun image via a one-off `docker compose run`:
#   docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
#     --env-file infra/env/.env.prod run --rm migrate bun run reindex:all
# (the default CMD is migrate+seed; `run` overrides it). See docs/05-runbooks/deploy-self-hosted.md §2a.
# apps/api/package.json (with the `reindex:all` script) is already copied above.
COPY apps/api/src/           apps/api/src/
COPY apps/api/scripts/       apps/api/scripts/

WORKDIR /app/apps/api
RUN bunx prisma generate          # generated client is needed by prisma/seed.ts and the reindex script

USER bun

# Apply all pending migrations non-interactively, then run the idempotent seed. DATABASE_URL
# is injected by compose; prisma.config.ts reads it. Exits when done (one-shot job).
# NOTE: the seed runs on EVERY deploy (compose re-runs this job on `up`), so prisma/seed.ts MUST
# stay idempotent (upsert by unique key) — do not add non-idempotent rows (e.g. a default admin).
CMD ["sh", "-c", "bunx prisma migrate deploy && bunx prisma db seed"]
