---
title: Decisions (ADRs) — MOC
tags: [moc, adr]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Decisions (ADRs) — Map of Content

Architecture Decision Records in **MADR-lite** format: *Context → Considered options →
Decision → Consequences*. Each ADR is immutable once `accepted`; to reverse one, write a
new ADR that supersedes it (and set the old one's status to `superseded`).

Use [[0000-adr-template]] as the starting point for new records.

## Status vocabulary

`proposed` · `accepted` · `rejected` · `superseded` · `deprecated`

## Records

| # | Title | Status |
| --- | --- | --- |
| [[0001-monorepo-bun-turborepo]] | Monorepo with Bun workspaces + Turborepo | accepted |
| [[0002-nestjs-backend]] | NestJS for the backend | accepted |
| [[0003-prisma-orm]] | Prisma as ORM on PostgreSQL | accepted |
| [[0004-asset-centric-design]] | Asset-centric domain design | accepted |
| [[0005-id-strategy]] | Mixed ID strategy (uuid / cuid / autoincrement) | accepted |
| [[0006-soft-delete-and-auditing]] | Soft delete & append-only auditing | accepted |
| [[0007-flexible-asset-specs-jsonb]] | Flexible asset specs via jsonb | accepted |
| [[0008-consumables-vs-assets]] | Consumables modeled separately from assets | accepted |
| [[0009-bun-first-vs-app-stack]] | Bun-first guidance vs the chosen app stack | accepted |

## Pending ADRs (to write when decided)

- **Authentication** — NextAuth vs better-auth (see [[stack]]).
- **Async workers** — BullMQ + Redis (note the [[0009-bun-first-vs-app-stack]] tension:
  BullMQ pulls in `ioredis`, which `CLAUDE.md` discourages).
- **UI kit** — shadcn/ui + Tailwind.
- **Deployment topology** — see [[deployment]].
