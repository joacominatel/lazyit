---
title: "ADR-0047: Guided first-deploy bootstrap script (infra/start.sh)"
tags: [adr, infra, deployment, secrets, dx]
status: accepted
created: 2026-06-02
updated: 2026-10-09
deciders: [Joaquín Minatel]
---

# ADR-0047: Guided first-deploy bootstrap script (infra/start.sh)

## Status

accepted

**Amended** — 2026-10-09 (#1543) by [[0102-remove-bundled-zitadel]]: the authentication question is two-way
(built-in accounts or your own OIDC IdP). `start.sh` no longer generates `ZITADEL_MASTERKEY` or any other
`ZITADEL_*` key, and it refuses to start when it finds bundled-Zitadel leftovers. The rest of this record
still binds.

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
  - `POSTGRES_PASSWORD`, `ZITADEL_DB_PASSWORD` = `openssl rand -hex 24` (**URL-safe** — see below);
    `MEILI_MASTER_KEY` = `openssl rand -base64 24`; `AUTH_SECRET` = `openssl rand -base64 33`.
  - `POSTGRES_PASSWORD` is substituted **identically** into `DATABASE_URL` (internal-DB mode), so it
    **must be URL-safe**: a base64 `/` (or any of `: @ ? #`) terminates the URL authority early and
    Prisma rejects the string at the migrate step with `P1013: invalid port number in database URL`.
    Hence `-hex` (not `-base64`) for this secret, plus a `generate_secrets` guard that aborts if the
    value ever carries a URL-authority delimiter.
  - A Zitadel-complexity console admin password (random, surfaced **once** in the final output).
  - The operator's domain/origin/issuer/port answers. **Every free-text answer is validated**
    before use (newline + control characters rejected outright — they could inject an extra
    `KEY=value` line or shell metacharacters; FQDN against a hostname charset; ACME email against a
    basic shape; ports numeric 1–65535; BYOI issuer must be an `https://` URL); a bad value
    re-prompts (interactive) or aborts (`--yes`).
  - **Atomic, validated write, secret-safe from the first byte:** the `.tmp` is created under
    `umask 077` so it is **mode 600 at creation — before any secret is written** (a plain
    `: >tmp` would honour the shell umask → 644, leaving the whole secret set world-readable in a
    world-traversable dir for the render+validate window — [[0028-secrets-and-config]]). Then
    render, validate (every active `CHANGE_ME` replaced, `MASTERKEY` length 32 in bundled mode,
    ports numeric, `DATABASE_URL` password matches `POSTGRES_PASSWORD`, and in **BYOI** no bundled
    Zitadel key / internal `zitadel:8080` URL survives as an active line), and `mv` into place
    (`mv` preserves the 600 mode); `stat` verifies it.
  - **BYOI consistency:** in BYOI mode the bundled-Zitadel-only vars (`ZITADEL_MASTERKEY`,
    `ZITADEL_DB_PASSWORD`, `ZITADEL_EXTERNALDOMAIN`, `ZITADEL_ADMIN_PASSWORD`) and the internal
    server-to-server URLs (`OIDC_JWKS_URI`, `AUTH_INTERNAL_ISSUER` → `zitadel:8080`) are left
    **unset** (commented), so the rendered file reflects the operator's own issuer with no stale
    bundled-Zitadel leftovers.
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
  secrets. (Amended 2026-09-26: on an existing install it may *append* a missing key from a narrow
  allowlist of safely generatable keys — see the amendment below.) There is **no** teardown / `down -v` / `volume rm` path anywhere in the script — a
  destructive reset stays a documented **manual** operation ([[docker-prod-like-first-boot]] §Teardown).

**Print-only (do NOT auto-edit compose/Caddyfile)** — by decision, for **BYOI**, **external
Postgres**, and **TLS/HSTS**: the script prints the exact manual instruction (drop the Zitadel
services / don't start `db` / uncomment the Caddyfile `email` + `import hsts`) and writes the
relevant env values, but never edits `compose.yaml`, `infra/docker-compose.prod.yaml`, or the
`Caddyfile`. This keeps the script a thin wrapper and the compose/proxy assets the single source of
truth.

## Amendment — 2026-09-26: an existing install gets missing, safely generatable keys appended

**Decision (CEO, 2026-09-26 — "start.sh la genera sola").** Upgrading with `git pull` +
`./infra/start.sh` takes the existing-install branch, which used to skip every write and go straight to
`up`. A key the new release introduced therefore stayed missing, and the operator met it as a bare 409
(e.g. `SMTP_SECRET_KEY`, [[0079-instance-smtp-outbound-email]]) with only a printed hint. From now on,
on that branch and before `up`, `start.sh` **appends** to `infra/env/.env.prod` every key that is:

1. defined in the checkout's `infra/env/.env.prod.example` — an active line, or a commented `# KEY=`
   placeholder for an optional key (either way, this release knows the key);
2. **missing** from `.env.prod` — no active `KEY=` line (a present line of any value, even empty, is
   never touched); and
3. on the explicit allowlist `SAFE_GENERATABLE_KEYS` in `start.sh`.

**The allowlist is the safety gate.** A key qualifies only if a random fresh value can never orphan data
or identity on a populated install that lacks it. Today: **`SMTP_SECRET_KEY`**
([[0079-instance-smtp-outbound-email]]), **`AI_SECRET_KEY`** ([[0097-ai-assistant-mcp-and-headless-api]]) and
**`DIRECTORY_SECRET_KEY`** ([[0091-on-prem-ad-ldap-directory-source]], added by issue #1271), all
`openssl rand -hex 32`. Each is the at-rest key for a secret the API **refuses to store (409)** while the
key is unset, so a missing key proves nothing was ever encrypted under it. `AI_SECRET_KEY` ships
*commented* in the example (so `infra/update.sh` never stops an instance that does not use AI); criterion
1 accepts the commented placeholder precisely so this optional key can still be supplied — it is new in
v2.0, a fresh install and `--reconfigure` already write it, and without it the first provider-key save
409s. `DIRECTORY_SECRET_KEY` follows the same shape for the same reason (directory sync is optional and off
by default): commented in the example, written active by a fresh install, `--reconfigure` and this append.

The allowlist also relies on *where* the API reads these keys: only from its process env, which compose
fills from `.env.prod` through `env_file` — the api service's `environment:` block names none of them, and
the operator's shell env never reaches the container. An operator who set one in their own compose overlay
instead still wins after the append (an overlay's `environment:` outranks `env_file`, and an overlay's
`env_file` merges after `.env.prod`), so appending can never swap the key the API decrypts with.

**Never on the allowlist** — keys that protect existing data or identity: `WORKFLOW_SECRET_KEY`
([[0054-applications-workflow-engine]] — the connector-credential linchpin), `ZITADEL_MASTERKEY`,
`AUTH_SECRET`, `SESSION_SIGNING_SECRET`, `POSTGRES_PASSWORD` / `ZITADEL_DB_PASSWORD` (the databases
already carry the old ones), `MEILI_MASTER_KEY`. For every non-allowlisted key the behaviour is
unchanged: `start.sh` only **names** the missing key and points at the example's comment; the API fails
loud at boot for a required one, and `infra/update.sh` still stops before touching the stack.

**Write discipline.** A mode-600 backup `infra/env/.env.prod.bak-<UTC timestamp>` is taken first;
existing lines are never modified or reordered (the new file must begin with the old one byte-for-byte —
asserted before it goes live); the keys go at the end under one dated `# --- Added by infra/start.sh on
… ---` comment; the file is written through a mode-600 temp and an atomic `mv`, so it stays 600; only key
**names** are printed, never values; `--dry-run` names what it would add and writes nothing. A second run
finds nothing missing and writes nothing. It works for local, BYOI and bundled-Zitadel installs alike —
unlike `--reconfigure`, which refuses OIDC because it *re-renders* the file; appending re-renders nothing.

**Why not `infra/update.sh` too.** `update.sh`'s contract is "detect, never edit `.env.prod`" (it runs
the operator's *old* copy of itself, and its fail-loud step is the review point for a new release's
keys). That stays; its missing-env stop still lists `SMTP_SECRET_KEY` for a v1.11 file, and the runbook
offers both fixes. Covered by `infra/test/start-adds-missing-keys.sh` (run in CI).

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
