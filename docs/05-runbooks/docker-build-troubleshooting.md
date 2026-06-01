---
title: Docker Build & Boot Troubleshooting
tags: [runbook, docker, troubleshooting]
status: accepted
created: 2026-05-25
updated: 2026-05-25
---

# Runbook — Docker build & boot troubleshooting

Symptoms and fixes for building/running the lazyit images ([[0025-containerization-strategy]]).
Build everything from the **repo root** (the workspaces need the whole monorepo as build context).

## `the --mount option requires BuildKit`

The Dockerfiles avoid BuildKit-only features so they build on the legacy builder too. If you added
a `--mount=type=cache` (or `# syntax`-only feature) and hit this, either enable BuildKit
(`DOCKER_BUILDKIT=1 docker build …`, needs the `buildx` component) or drop the cache mount.
`docker compose build` and GitHub Actions use BuildKit/buildx and are unaffected.

## Image is huge (~1 GB) for the API

The API image must contain **only the API's** production dependencies. The recipe (in
`infra/docker/api.Dockerfile`) is:

```sh
bun install --production --linker hoisted --filter "@lazyit/api"
```

- `--filter "@lazyit/api"` excludes the **web** app's deps (Next/React — hundreds of MB). Without
  it, a root install pulls every workspace's deps into the image.
- `--linker hoisted` gives a flat `node_modules` (no `.bun/` store) so plain Node resolution works
  when copied into the runtime stage.
- `--production` drops devDependencies. (It implies a frozen lockfile; keeping all workspace
  `package.json`s present keeps the lockfile unchanged so that check passes.)

The **migrate** image is intentionally larger (~1 GB): it needs the Prisma **CLI** (a
devDependency) so it can't use `--production`. It's a one-shot job, so size is acceptable; slimming
it (promoting just the Prisma CLI) is recorded as optimization debt.

## `Cannot find module '/app/apps/api/dist/main'`

`nest build` emits to **`dist/src/main.js`** (because `sourceRoot: src` in `nest-cli.json`), and the
generated Prisma client compiles to `dist/generated/`. The container CMD is therefore
`node apps/api/dist/src/main`. If you change the build output layout, update the CMD to match.

## Web image / Next.js standalone

The web image runs the Next.js **standalone** server (`output: 'standalone'` in
`apps/web/next.config.ts`). The build emits `apps/web/.next/standalone/` (a traced, minimal
server). In this monorepo the entry lands at `apps/web/server.js` inside the standalone root, with
`static` and `public` copied alongside — that's what `web.Dockerfile` copies. If `next build` ever
stops emitting standalone, confirm `output: 'standalone'` is still set.

`NEXT_PUBLIC_API_URL` is baked at **build** time (default `/api`, a build ARG). To point the web
app elsewhere, rebuild with `--build-arg NEXT_PUBLIC_API_URL=…` — it cannot be changed at runtime.

## API exits immediately: `DATABASE_URL is not set`

The API reads `DATABASE_URL` from its environment (not a `.env` file — `node dist/...` doesn't load
one). In compose it comes from `env_file: env/.env.prod`. Make sure `infra/env/.env.prod` exists and
sets `DATABASE_URL` (host `db`, matching `POSTGRES_*`).

## Postgres container won't start

If `POSTGRES_PASSWORD` is empty, Postgres **fails closed** (refuses to start) — by design
([[0028-secrets-and-config]] / SEC-005). Set a non-empty password in `.env.prod`.

## `migrate` fails or the API never starts

The API waits for `migrate` to exit successfully (`service_completed_successfully`). Inspect it:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod logs migrate
```

Common causes: bad `DATABASE_URL`, the DB not healthy yet (it waits, but check `db` logs), or a
genuinely failing migration. The seed runs via Bun (`bun prisma/seed.ts`) and is idempotent; the
migrate image uses a Debian-based Bun so the Prisma schema engine binary is present (Alpine/musl
would need extra libs).

## Jest fails to start (`protectProperties` / NodeEnvironment) — CI

jest@30 does not initialize under Bun's runtime. Run it under **Node**:
`node node_modules/.bin/jest` (not `bun run test`). CI does this via an `actions/setup-node` step.
`bun test` is only for `@lazyit/shared` and scripts ([[0009-bun-first-vs-app-stack]]).

## Browser warns about the certificate (local prod-like)

Caddy uses its **internal CA** for `localhost`, which your browser doesn't trust by default. Either
accept the warning, or trust Caddy's root CA once:

```sh
docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod \
  cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-local-root.crt
# then add ./caddy-local-root.crt to your OS/browser trust store
```

For a real domain on a public host, Caddy uses Let's Encrypt (publicly trusted) — no warning.

## HTTP→HTTPS redirect points to the wrong port (local)

On the high ports (8080/8443), Caddy's automatic HTTP→HTTPS redirect targets the standard `:443`
(it doesn't know the external host port). Just open **https://localhost:8443** directly. On a real
host using 80/443 this is a non-issue.

Related: [[docker-prod-like-first-boot]] · [[deploy-self-hosted]] · [[backups]] ·
[[0025-containerization-strategy]] · [[0026-reverse-proxy-tls]]
