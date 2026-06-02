---
title: "ADR-0047: Guided first-deploy bootstrap script (infra/start.sh)"
tags: [adr, infra, deployment, secrets, dx]
status: accepted
created: 2026-06-02
updated: 2026-06-02
deciders: [Joaquín Minatel]
---

# ADR-0047: Guided first-deploy bootstrap script (infra/start.sh)

## Status

accepted

## Context

The target operator is an **IT generalist who barely knows Docker** ([[0015-deployment-model]]).
The first deploy today is a manual sequence with several sharp edges, documented across the two
first-boot runbooks ([[docker-prod-like-first-boot]], [[deploy-self-hosted]]):

1. `cp infra/env/.env.prod.example infra/env/.env.prod` and hand-edit several `CHANGE_ME` values.
2. Generate secrets with `openssl` — including **`ZITADEL_MASTERKEY`, which must be EXACTLY 32
   chars** or Zitadel's first boot fails ([[0037-idp-choice-zitadel-byoi]], [[0043-zitadel-source-of-truth]]).
3. Keep the password inside `DATABASE_URL` **identical** to `POSTGRES_PASSWORD`.
4. `chmod 600` the file ([[0028-secrets-and-config]]).
5. Run the long `docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod
   --env-file infra/env/.env.prod up -d --build` invocation.

Every step is a place to slip. A wrong `MASTERKEY` length, a mismatched DB password, or a forgotten
`chmod` are all real first-boot failures or security holes. We want a **guided, idempotent,
non-destructive** wrapper that removes the toil **without** duplicating or replacing any existing
infra asset.

Two boundaries are firm and pre-existing, and the script must respect them:

- The **in-app `/setup` wizard** creates the first ADMIN ([[0043-zitadel-source-of-truth]] §5;
  [[auth-bootstrap]] §6b). The script must **not** create any user.
- The **`zitadel-bootstrap` sidecar** does all Zitadel plumbing (project, OIDC app, roles, SA key)
  — zero-touch ([[0043-zitadel-source-of-truth]] §4). The script must **not** call any Zitadel API
  or generate OIDC client creds.

So the script is a **thin wrapper** over `infra/env/.env.prod.example` (the secret contract,
ADR-0028) and the canonical prod compose. It writes **no** application logic and changes **no**
contract.

## Considered options

- **Keep the purely manual runbook** — zero new code, but the sharp edges remain (especially the
  32-char `MASTERKEY` and the `DATABASE_URL`/`POSTGRES_PASSWORD` coupling). Rejected: the toil is
  exactly what trips the target operator.
- **A heavier installer (Make target, Python/Bun CLI, TUI)** — more capable, but adds a runtime
  dependency and complexity for a once-per-host action; over-engineered for a single-host,
  single-org product. Rejected (YAGNI).
- **A thin POSIX `sh` bootstrap (`infra/start.sh`)** *(chosen)* — no new runtime (every target host
  already has `sh`, `docker`, `openssl`), a single file, idempotent and non-destructive. It detects,
  asks ~6 questions, renders the env file with real random secrets, and invokes the **existing**
  prod compose. The manual runbook steps stay as the documented fallback.

## Decision

Add **`infra/start.sh`** — an executable, POSIX `sh` (`set -eu`), guided first-deploy bootstrap.

**Shape: DETECT → ASK → GENERATE → UP → POINT.**

- **DETECT** (fails with a clear remedy, never half-runs): `docker` present + daemon reachable;
  Compose **v2** (`docker compose version`); `openssl` present; run-from-repo-root (asserts
  `compose.yaml` + `infra/docker-compose.prod.yaml` + the env example exist); free host ports for
  Caddy (offers alternates if busy — only Caddy publishes ports; DB/Meili/Zitadel are internal, so
  no host-port check for them); RAM/disk **WARN** (never hard-fail) against the runbook floor
  (2 vCPU / 4 GB / 20 GB); and the existing-install probe below.
- **ASK** — only what can't be detected or safely defaulted (~6 questions): deployment mode
  (local prod-like *default* vs real domain); public FQDN (`localhost` default → `auth.localhost`,
  with the hosts-file note); TLS (Caddy internal CA vs Let's Encrypt + ACME email) and host ports;
  bundled Zitadel vs **BYOI**; bundled internal Postgres vs **external**; and an opt-in for the
  backup sidecar. A `--yes`/`--non-interactive` path accepts localhost defaults for a smoke test;
  `--dry-run` does everything **except** write the file and run docker.
- **GENERATE** `infra/env/.env.prod`, rendered from the `.example` (the secret contract):
  - `ZITADEL_MASTERKEY` = `openssl rand -hex 16` (16 bytes → 32 hex chars), **asserted to be
    exactly 32 chars** before it is written, else abort.
  - `POSTGRES_PASSWORD`, `ZITADEL_DB_PASSWORD`, `MEILI_MASTER_KEY` = `openssl rand -base64 24`;
    `AUTH_SECRET` = `openssl rand -base64 33`.
  - `POSTGRES_PASSWORD` is substituted **identically** into `DATABASE_URL` (internal-DB mode).
  - A Zitadel-complexity console admin password (random, surfaced **once** in the final output).
  - The operator's domain/origin/issuer/port answers.
  - **Atomic, validated write:** render to a `.tmp`, validate (every active `CHANGE_ME` replaced,
    `MASTERKEY` length 32, ports numeric, `DATABASE_URL` password matches `POSTGRES_PASSWORD`),
    `chmod 600`, then `mv` into place; `stat` verifies the mode.
- **UP** — the exact canonical bring-up (unchanged from the runbooks):
  `docker compose -f compose.yaml -f infra/docker-compose.prod.yaml --profile prod
  --env-file infra/env/.env.prod up -d --build` (+ `--profile backup` if chosen).
- **POINT** — print the public URL, the "copy `.env.prod` off-host — it holds the unrotatable
  `MASTERKEY`" warning, the `auth.localhost` hosts note (local mode), and the single CTA: **open
  `https://<host>/setup`**. Nothing past that.

**Safety (non-negotiable):**

- **Idempotent + non-destructive.** An install is "existing" if **either** `infra/env/.env.prod`
  exists **or** any prod volume `lazyit-prod_*` is present. On an existing install the script
  **skips all generation** and goes straight to `up`. If volumes exist but the env file is
  **missing**, it **aborts** and tells the operator to restore `.env.prod` from their off-host
  backup — it never regenerates a `MASTERKEY` that cannot decrypt the existing Zitadel data.
- **Never** regenerates `ZITADEL_MASTERKEY` (the unrotatable DR linchpin) or overwrites existing
  secrets. There is **no** teardown / `down -v` / `volume rm` path anywhere in the script — a
  destructive reset stays a documented **manual** operation ([[docker-prod-like-first-boot]] §Teardown).

**Print-only (do NOT auto-edit compose/Caddyfile)** — by decision, for **BYOI**, **external
Postgres**, and **TLS/HSTS**: the script prints the exact manual instruction (drop the Zitadel
services / don't start `db` / uncomment the Caddyfile `email` + `import hsts`) and writes the
relevant env values, but never edits `compose.yaml`, `infra/docker-compose.prod.yaml`, or the
`Caddyfile`. This keeps the script a thin wrapper and the compose/proxy assets the single source of
truth.

## Consequences

- **Positive:** the first deploy becomes one guided command; the three classic foot-guns (32-char
  `MASTERKEY`, `DATABASE_URL`/`POSTGRES_PASSWORD` coupling, forgotten `chmod 600`) are eliminated by
  construction and asserted before the file goes live. Secrets are strong by default. The script is
  idempotent, so re-running it is safe (it never clobbers an existing `.env.prod` or volume). No new
  runtime dependency.
- **Trade-offs:** the script renders the env file but, by decision, does **not** auto-edit
  compose/Caddyfile for BYOI / external-Postgres / Let's-Encrypt — the operator applies those few
  manual edits (the script prints them). The Zitadel console admin password is shown **once**; if
  the operator loses it, recovery is via the documented Zitadel reset, not the script.
- **Boundaries preserved:** the script creates **no** user (that is the `/setup` wizard) and makes
  **no** Zitadel API call (that is the `zitadel-bootstrap` sidecar). It only renders the env file
  and invokes the existing prod compose.
- **Docs:** `infra/start.sh` becomes the **recommended** path in both first-boot runbooks; the
  manual `cp` / `openssl` / `chmod` / `up` steps remain documented as the explicit fallback.
- **Follow-ups:** if BYOI / external-Postgres become common, revisit whether a generated overlay
  (e.g. a `profiles: [never]` override file) is worth auto-emitting — out of scope here.

Related: [[0028-secrets-and-config]] · [[0025-containerization-strategy]] · [[0026-reverse-proxy-tls]] ·
[[0037-idp-choice-zitadel-byoi]] · [[0043-zitadel-source-of-truth]] · [[0015-deployment-model]] ·
[[docker-prod-like-first-boot]] · [[deploy-self-hosted]] · [[auth-bootstrap]]
