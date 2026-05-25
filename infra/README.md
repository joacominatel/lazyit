# infra/ — deployment & operations

Everything needed to run lazyit as containers lives here. lazyit is **self-hosted, single-org**
(ADR-0015): one instance = one organization, run on a single host with Docker Compose. This is the
DevOps lane (skill: `.claude/skills/lazyit-devops/SKILL.md`); the source of truth is `docs/`.

## Layout

```
infra/
├── docker-compose.prod.yml   # prod-like / self-hosted stack: db + migrate + api + web + caddy
├── docker/
│   ├── api.Dockerfile        # NestJS on Node, built with Bun (multi-stage)        — ADR-0025
│   ├── web.Dockerfile        # Next.js standalone on Node, built with Bun          — ADR-0025
│   └── migrate.Dockerfile    # one-shot Bun job: `prisma migrate deploy` + seed    — ADR-0025
├── caddy/
│   └── Caddyfile             # reverse proxy + automatic HTTPS, same-origin /api    — ADR-0026
└── env/
    └── .env.prod.example     # template for the (gitignored) .env.prod             — ADR-0028
```

## Deployment levels

| Level | How | Notes |
| --- | --- | --- |
| **Dev** | root `docker-compose.yml` (Postgres) + `bun run dev` | apps run natively. Not in this folder. |
| **Local prod-like** | `docker-compose.prod.yml` | full stack in containers, HTTPS via Caddy's internal CA, high ports (8080/8443). |
| **Self-hosted real** | same compose + real domain | Let's Encrypt, real secrets, backups. See runbooks. |

## Quick start (local prod-like)

```sh
cp infra/env/.env.prod.example infra/env/.env.prod   # then edit: replace every CHANGE_ME
chmod 600 infra/env/.env.prod
docker compose -f infra/docker-compose.prod.yml up -d --build
# open https://localhost:8443  (Caddy's internal CA → accept/trust the local cert)
```

Full walkthrough: `docs/05-runbooks/docker-prod-like-first-boot.md`.
Real deployment: `docs/05-runbooks/deploy-self-hosted.md`.
Build problems: `docs/05-runbooks/docker-build-troubleshooting.md`.
Backups: `docs/05-runbooks/backups.md`.

## Key design points

- **Build with Bun, run on Node.** The app runtime is Node (`node dist/main`), not Bun — ADR-0009.
  Images are multi-stage: `oven/bun` builder → `node:26-alpine` runtime.
- **Migrations are a one-shot job.** `migrate` runs `prisma migrate deploy` + seed after Postgres is
  healthy and before the API starts. The seed needs Bun (`bun prisma/seed.ts`).
- **Same-origin routing.** Caddy serves the web at `/` and forwards `/api/*` to the API (stripping
  the prefix; `/api/docs*` is passed through for Swagger). The web image bakes
  `NEXT_PUBLIC_API_URL=/api`, so one image works on any domain — ADR-0026.
- **Least exposure.** Only Caddy publishes ports. Postgres/API/Web are on the internal network;
  Postgres is never reachable from the host — ADR-0028 / SEC-005.
- **Secrets** live in the gitignored `env/.env.prod` (copied from the example). Never committed,
  never trivial — ADR-0028.

## Not configured yet (reserved)

- **Auth / IdP** (ADR-0016): a commented route stub in the `Caddyfile` and commented `OIDC_*`
  placeholders in `.env.prod.example`. No IdP is wired.
- **CD / image publishing** (ADR-0027): CI builds the images but does not push. Registry will be
  GHCR when a deploy target exists.
