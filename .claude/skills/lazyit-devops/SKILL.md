---
name: lazyit-devops
description: >-
  DevOps / deployment method for the lazyit monorepo: containerization (Docker multi-stage
  images for apps/api and apps/web), the prod-like and self-hosted Docker Compose topology in
  infra/, the Caddy reverse proxy + TLS, GitHub Actions CI, secrets/config handling, and the
  deployment runbooks. Invoke when asked to build/change a Dockerfile or compose file, set up
  or debug CI/CD, configure the reverse proxy, manage prod env/secrets, write a deployment or
  build-troubleshooting runbook, or make any infrastructure decision in this repo. FIND-and-BUILD
  for infra only: this role writes to infra/, .github/, root .dockerignore, docs/05-runbooks/,
  docs/03-decisions/ (new ADRs) and docs/01-architecture/deployment.md. NOT for application code
  (apps/, packages/) — that is the feature agents' lane.
---

# lazyit DevOps

Method and lane for the **deployment / infrastructure / CI-CD** work in the lazyit monorepo.

> **Source of truth is always `docs/`.** This skill is *how the DevOps lane works* and *where its
> artifacts live* — it links into `docs/` rather than repeating it. Precedence on any conflict:
> **`docs/` > root `CLAUDE.md` > this skill.** Read the navigator skill
> (`.claude/skills/lazyit-navigator/SKILL.md`) for general repo orientation — it belongs to the
> feature agents, not this lane, but it maps the repo.

## 0. Lane — what this role may and may not touch

**Writes to (this lane):**
- `infra/` — Dockerfiles, compose files, Caddy config, prod env templates, infra README.
- `.github/workflows/` — CI pipelines.
- root `.dockerignore`.
- `docs/05-runbooks/` — deployment / build / troubleshooting runbooks.
- `docs/03-decisions/` — **new** ADRs (sequential numbering; check the last one first).
- `docs/01-architecture/deployment.md` — the deployment architecture doc.
- The dev root `docker-compose.yml` — **only careful, non-breaking improvements** (healthcheck,
  named volumes, loopback bind). Structural changes go in `infra/docker-compose.prod.yml` instead.

**Does NOT touch:** `apps/`, `packages/` (application lane), other agents' skills
(`lazyit-navigator`, `lazyit-sentinel`, `lazyit-remediator`). A Dockerfile **reads** (`COPY`s) app
code into an image — that is allowed; **editing** app source is not.

**Cross-lane exception protocol.** If a build genuinely needs a one-line app change (e.g.
`output: 'standalone'` in `apps/web/next.config.ts`), **escalate and get explicit authorization
first**, then make it as an isolated commit (`chore:` prefix, message noting "authorized cross-lane
edit"), and record it as out-of-lane in the final report.

## 1. Deployment philosophy

lazyit is **self-hosted, single-org** — *one instance = one organization*, run inside the
customer ([[0015-deployment-model]]). This drives every infra choice:

- **No multi-tenancy, no SaaS infrastructure.** No tenant scoping, no hosted control plane,
  no billing. Boring, durable, operable by a 5–20-person team.
- **Auth is deferred to the customer's external IdP** (OIDC; Authentik/Keycloak/Zitadel TBD —
  [[0016-auth-strategy-deferred]]). The current build is **unauthenticated and dev-only**; the
  `X-User-Id` shim ([[0022-draft-visibility-auth-shim]], [[0024-asset-assignment-actor-shim]]) is
  forgeable by design. **Do not expose the current build publicly.** Infra leaves a *slot* for the
  future IdP but does not configure it.
- **Integration-friendly, not lock-in.** Anything that ties the product to a hosted vendor
  (SaaS auth, managed-only services) is off the table — it would kill self-hosting.

Single-host **Docker Compose** is the target topology for this scale; do not reach for
Kubernetes/Nomad. If a simple solution suffices, use it.

## 2. Stack target (what gets containerized)

| Component | Image | Notes |
| --- | --- | --- |
| **Postgres** | `postgres:18-alpine` | Same as dev. Named volume; **never** publish its port in prod (internal network only). |
| **API** runtime | `node:26-alpine` | NestJS 11 runs on **Node** (`node dist/main`), not Bun — [[0009-bun-first-vs-app-stack]]. |
| **Web** runtime | `node:26-alpine` | Next.js 16 standalone server (`node server.js`). |
| **Build** stage | `oven/bun:1.3.14` (Debian) | Bun is the build/tooling default; builds `shared` + the app, runs `prisma generate` / `next build` / `nest build`. |
| **Migrate+seed** | `oven/bun:1.3.14` (Debian) | One-shot job: `prisma migrate deploy && prisma db seed`. **Seed needs Bun** (`bun prisma/seed.ts`). Debian (glibc) avoids the Prisma schema-engine musl pitfall. |
| **Reverse proxy** | `caddy:2-alpine` | Auto-HTTPS: internal CA for local, Let's Encrypt for a real domain. |

Key facts that shape the images (verified against the repo):

- **API runs on Node, builds with Bun.** Reaffirmed in [[0025-containerization-strategy]].
- **Prisma 7 uses a driver adapter** (`@prisma/adapter-pg`) with the `prisma-client` generator →
  **no Rust query-engine binary at runtime**. The generated client (`apps/api/generated/prisma`,
  gitignored) is portable JS → Alpine runtime is fine. Must run `prisma generate` at build time.
- **`NEXT_PUBLIC_API_URL` is baked at build time** (client bundle). We set it to the **relative
  `/api`** so the web image is **domain-portable** (one image, any host) — [[0026-reverse-proxy-tls]].
- **All web→API calls are client-side** (every `apiFetch` importer is `"use client"`). The browser
  reaches the API same-origin through Caddy; no server-side fetch, no CORS needed.
- **Build context is the repo root** (workspaces use `workspace:*`). Dockerfiles live in
  `infra/docker/` and build with `-f infra/docker/<x>.Dockerfile .`.
- **API health:** `GET /` → `Hello World!` (no DB touch) — usable as a container healthcheck.
  Migrations in prod use **`prisma migrate deploy`** (non-interactive) — [[prisma-migrations]].

## 3. Deployment levels

1. **Dev** (exists): root `docker-compose.yml` (Postgres only) + `bun run dev` for the apps natively.
   This lane only hardens it (loopback bind, healthcheck) — never breaks it.
2. **Local prod-like**: `infra/docker-compose.prod.yml` brings up Postgres + migrate + API + web +
   Caddy with one command. HTTPS local via Caddy's internal CA. Uses **high ports** (Caddy
   `8080`/`8443`) so it never clashes with dev (`3000`/`3001`/`5432`).
3. **Self-hosted real**: same compose, prod env (`infra/env/.env.prod`), real domain + Let's Encrypt,
   Postgres on the internal network only, host-protected secrets, backups configured. **Documented**
   in [[05-runbooks/_MOC|runbooks]]; not necessarily executed here.

## 4. Conventions

- **Multi-stage Dockerfiles**: Bun builder → minimal Node/Alpine runtime. Copy only built artifacts
  + production deps into the runtime stage.
- **Run as non-root** (`node` / `bun` user). **Healthcheck on every long-running service.**
- **Named volumes**, not bind mounts, for stateful data in prod.
- **One `.env` per level** with a committed `.env.example`. **Real `.env*` are gitignored; secrets
  are never committed and never trivial even in examples** (placeholders are `CHANGE_ME`).
- **Image tags**: `lazyit-api` / `lazyit-web` (+ `:dev` locally). Commit-SHA + `latest` for dev,
  semver for prod (future, with CD).
- **English everywhere** in artifacts (code, configs, comments, docs) — repo convention.
- **Commits are file-by-file**: `feat:` for new infra, `chore:` for CI/config, `docs:` for
  runbooks/ADRs. Never `git add -A`/`.`, never `commit --amend`/`rebase`/`reset` (other agents
  commit in parallel) — see [[claude-workflow]].

## 5. CI/CD strategy

CI runs on every **PR** and **push to `master`** (`.github/workflows/ci.yml`):
1. Install (Bun, pinned `1.3.14`, cached on `bun.lock`).
2. `prisma generate` (**before** typecheck/test — the generated client is imported in code and specs).
3. Typecheck (`tsc --noEmit` per workspace).
4. Lint — **`eslint` without `--fix`** (the repo's `lint` script uses `--fix`, which mutates files
   and masks failures; CI must gate, not rewrite).
5. Test — api Jest (**mocks the Prisma client → no DB needed**) + shared `bun test`.
6. Build all workspaces (`turbo build`).
7. Build the Docker images (`push: false`, GHA layer cache) — validates the Dockerfiles.

**CD is deferred** — no deploy target yet ([[0027-ci-pipeline]]). When it lands, the registry is
**GHCR** (decided direction). Images are **not published** today.

## 6. What requires an ADR

Create a new ADR (sequential number; check the last one) for any of:
- Runtime choice for an app in prod (Node vs Bun — anchored by [[0009-bun-first-vs-app-stack]]).
- Reverse proxy / TLS strategy and web↔API routing.
- Containerization / image strategy (base images, multi-stage shape, migration execution).
- CI pipeline structure and CD posture.
- Secrets / configuration management — even if the decision is "env files for now".
- Anything that changes the deployment model ([[0015-deployment-model]]) or auth strategy
  ([[0016-auth-strategy-deferred]]).

## 7. When to escalate (🚨)

Stop and ask the user (do not decide alone) for:
- Any **external service**: image registry, secrets manager, monitoring, managed DB.
- Anything needing **budget, an external account, or a product decision**.
- **Reverse proxy / secrets / backup** strategy choices (confirm even when you have a recommendation).
- Any **cross-lane change** to `apps/` or `packages/` (authorize first — see §0).
- A finding that the current stack **isn't productizable without an app refactor**.
- Changes touching **ADR-0015** (deployment model) or **ADR-0016** (auth strategy).

---

Artifacts this lane owns: `infra/` · `.github/workflows/` · root `.dockerignore` ·
[[deployment]] · [[05-runbooks/_MOC|Runbooks]] · ADRs [[0025-containerization-strategy]] ·
[[0026-reverse-proxy-tls]] · [[0027-ci-pipeline]] · [[0028-secrets-and-config]].
