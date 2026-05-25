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

- **[[prisma-migrations]]** — evolve the schema: the normal `migrate dev` flow, the non-TTY
  workaround (hand-written SQL + `migrate deploy`), partial indexes, drift checks, and the
  one-commit-per-migration convention.

## Planned runbooks (write when real)

- **Deploy** — release the apps + run `prisma migrate deploy` (depends on [[deployment]]).
- **Database backup & restore** — Postgres dump/restore strategy.
- **Local DB reset** — covered for now by [[prisma-migrations]] §4 (`migrate reset`); promote to
  its own runbook if reset needs more than a dev wipe.
- **Incident / on-call** — once there's something in production.

Deployment design context: [[deployment]].
