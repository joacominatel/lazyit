# syntax=docker/dockerfile:1
#
# lazyit migrate+seed job — one-shot container, run before the API starts.
# Build from the repo ROOT:  docker build -f infra/docker/migrate.Dockerfile -t lazyit-migrate:dev .
# Rationale: ADR-0025. Runs on Bun (the seed is `bun prisma/seed.ts`); Debian/glibc so the
# Prisma schema engine used by `migrate deploy` finds its binary (avoids the Alpine/musl pitfall).

FROM oven/bun:1.3.14 AS runtime
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

WORKDIR /app/apps/api
RUN bunx prisma generate          # generated client is needed by prisma/seed.ts

USER bun

# Apply all pending migrations non-interactively, then run the idempotent seed. DATABASE_URL
# is injected by compose; prisma.config.ts reads it. Exits when done (one-shot job).
CMD ["sh", "-c", "bunx prisma migrate deploy && bunx prisma db seed"]
