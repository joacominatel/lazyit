# AGENTS.md

Guidance for cloud agents working in the lazyit monorepo.

## Cursor Cloud specific instructions

### Services (native dev)

| Service | How to run | Port |
| --- | --- | --- |
| PostgreSQL | `docker compose up -d db` (or `bun run db:up` for full infra) | `127.0.0.1:5432` |
| API | `bun run dev` (turbo) or `cd apps/api && bun run dev` | `3001` |
| Web | `bun run dev` (turbo) or `cd apps/web && bun run dev` | `3000` |
| Meilisearch / Zitadel | optional for shim-mode dev; started by `bun run db:up` | `7700` / `8080` |

Minimal E2E dev loop: **Postgres + API + Web**. Meilisearch and Zitadel are optional when `AUTH_MODE=shim`.

### Docker in this VM

Docker is not managed by systemd here. If `docker ps` fails with permission or connection errors:

1. Ensure `dockerd` is running (check `/tmp/dockerd.log` or start it with `sudo dockerd` in the background).
2. Use the `docker` group (`sg docker -c "docker ..."`) or add the user to the group.

Storage driver is `fuse-overlayfs` (see `/etc/docker/daemon.json`).

### Environment files

Copy all three examples on first setup (see `docs/04-development/setup.md`):

```sh
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
```

Fill `POSTGRES_PASSWORD` and `MEILI_MASTER_KEY` in the root `.env`; keep `DATABASE_URL` in `apps/api/.env` aligned with those Postgres credentials.

**Boot gotcha:** do not leave `OIDC_ISSUER=` as an empty string in `apps/api/.env` when using `AUTH_MODE=shim`. An empty value fails zod URL validation at API boot. Either omit the line or comment it out.

Generate `AUTH_SECRET` for `apps/web/.env` with `openssl rand -base64 32`.

### Prisma (first boot / after schema changes)

From `apps/api`:

```sh
bunx prisma generate      # required before seed/tests if client is missing
bunx prisma migrate deploy # or migrate dev locally
bunx prisma db seed
```

`@lazyit/shared` must be built before seed (`bun run build --filter=@lazyit/shared`).

### Standard commands

See root `package.json` and `docs/04-development/setup.md`:

- `bun install` - workspace deps
- `bun run dev` - web + api via turbo
- `bun run lint` / `bun run test` / `bun run build`
- `bun run db:up` / `bun run db:down` - docker compose backing services

### Dev auth (shim)

With `AUTH_MODE=shim`, authenticated API calls need `X-User-Id: <uuid>`. The seed creates `admin@lazyit.local`; query its id from Postgres or use the seeded admin for smoke tests. `/health/*` is public.

`POST /users` returns 503 without Zitadel management configured - expected in shim-only dev. Prefer asset/dashboard endpoints for core hello-world checks.

### Smoke test

```sh
curl http://localhost:3001/health/live
curl http://localhost:3001/health/ready
curl -H "X-User-Id: <admin-uuid>" http://localhost:3001/assets
open http://localhost:3000
open http://localhost:3001/api/docs
```

### Lint note

`bun run lint` may fail on pre-existing ESLint errors in `apps/web` (react-hooks rules). Tests and build are the stronger CI signals for env verification.
