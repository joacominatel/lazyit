---
title: Runbooks — MOC
tags: [moc, runbook]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Runbooks — Map of Content

Operational procedures: deploy, backups, recovery, on-call, troubleshooting.

> [!info] Empty by design
> There is nothing to operate yet. This folder fills in as operational reality appears.
> A runbook should be a concrete, do-this-then-that procedure — not theory. Knowledge-base
> articles for end users live in the domain as [[article]]s; **runbooks here are for the team
> operating lazyit itself.**

## Planned runbooks (write when real)

- **Deploy** — release the apps + run `prisma migrate deploy` (depends on [[deployment]]).
- **Database backup & restore** — Postgres dump/restore strategy.
- **Local DB reset** — drop/recreate the dev database.
- **Incident / on-call** — once there's something in production.

Deployment design context: [[deployment]].
