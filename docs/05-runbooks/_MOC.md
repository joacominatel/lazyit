---
title: Runbooks — MOC
tags: [moc, runbook]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Runbooks — Map of Content

Operational procedures: deploy, backups, recovery, on-call, troubleshooting.

> [!info] Fills in as reality appears
> A runbook should be a concrete, do-this-then-that procedure — not theory. Knowledge-base
> articles for end users live in the domain as [[article]]s; **runbooks here are for the team
> operating lazyit itself.** The first one (database migrations) exists; the rest are written
> when there's something real to operate.

## Available runbooks

- **[[git-workflow]]** — how every change reaches the codebase: `master`/`dev`/issue-branch
  strategy, branch naming, the hybrid issue model, the step-by-step agent loop (issue → branch
  → PR to `dev` → user merges), labels, the `Closes #n` auto-close caveat, and pending setup.
- **[[prisma-migrations]]** — evolve the schema: the normal `migrate dev` flow, the non-TTY
  workaround (hand-written SQL + `migrate deploy`), partial indexes, drift checks, and the
  one-commit-per-migration convention.
- **[[docker-prod-like-first-boot]]** — run the whole containerized stack locally (Postgres +
  migrate + API + web + Caddy) with local HTTPS; verify it; routine ops.
- **[[deploy-self-hosted]]** — install on a single host on a real domain: env/secrets, Let's
  Encrypt, bring-up, updates, the reserved IdP slot.
- **[[backups]]** — backups & disaster recovery: the full DR inventory (app DB + Zitadel DB +
  `.env.prod`/masterkey; Meili/Caddy rebuildable), the opt-in backup sidecar (cron + `pg_dump` for
  both DBs, retention, optional offsite), and the correct restore order (env → zitadel → app → up →
  reindex) with targeted volume removal instead of the destructive `down -v`.
- **[[docker-build-troubleshooting]]** — symptoms & fixes for building/booting the images.

## Planned runbooks (write when real)

- **Scheduled/offsite backup automation** — shipped: the opt-in `backup` profile sidecar in
  `infra/docker-compose.prod.yml` (cron + `pg_dump` for both DBs + retention + optional offsite
  hook), documented in [[backups]]. Promote to a standalone runbook only if it grows beyond that.
- **Secrets rotation** — per-secret steps (DB password needs `ALTER USER`, not just an env edit;
  `AUTH_SECRET` logs everyone out; `ZITADEL_MASTERKEY` is unrotatable-in-place). Sketched in
  [[deploy-self-hosted]]; write the full runbook when rotation cadence is set.
- **Local DB reset** — covered for now by [[prisma-migrations]] §4 (`migrate reset`); promote to
  its own runbook if reset needs more than a dev wipe.
- **Incident / on-call** — once there's something in production.
- **CD / image publishing** — when a deploy target exists ([[0027-ci-pipeline]]): publish to GHCR
  + deploy flow.

Deployment design context: [[deployment]].
