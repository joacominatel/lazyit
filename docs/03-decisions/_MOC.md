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
| [[0010-nextjs-frontend]] | Next.js for the frontend | accepted |
| [[0011-tailwind-styling]] | Tailwind CSS + shadcn/ui for styling | accepted |
| [[0012-testing-strategy]] | Testing strategy | accepted |
| [[0013-zod-validation-pipe]] | Zod validation via a custom ZodValidationPipe | superseded by [[0018-api-documentation-swagger]] |
| [[0014-shared-package-build]] | Build @lazyit/shared to CommonJS + declarations | accepted |
| [[0015-deployment-model]] | Deployment model — self-hosted for IT teams | accepted |
| [[0016-auth-strategy-deferred]] | Authentication deferred; external IdP when needed | accepted |
| [[0017-location-type-enum]] | Location type as a hardcoded enum (user-managed types deferred) | accepted |
| [[0018-api-documentation-swagger]] | API documentation with Swagger/OpenAPI (nestjs-zod) | accepted |
| [[0019-asset-assignment-integrity]] | AssetAssignment referential integrity & lifecycle | accepted (actor source superseded by [[0024-asset-assignment-actor-shim]]) |
| [[0020-frontend-data-layer]] | Frontend data layer (endpoints → hooks → components) | accepted |
| [[0021-knowledge-base-design]] | Knowledge Base design — simple wiki (Article + ArticleCategory) | accepted |
| [[0022-draft-visibility-auth-shim]] | Draft visibility & the `X-User-Id` auth shim | accepted (temporary) |
| [[0023-access-management-design]] | Access management design (Application + AccessGrant) | accepted |
| [[0024-asset-assignment-actor-shim]] | Retrofit AssetAssignment actor to the `X-User-Id` shim | accepted |
| [[0025-containerization-strategy]] | Containerization & image strategy (Bun build → Node runtime) | accepted |
| [[0026-reverse-proxy-tls]] | Reverse proxy & TLS (Caddy), same-origin `/api` routing | accepted |
| [[0027-ci-pipeline]] | CI on GitHub Actions; CD deferred | accepted |
| [[0028-secrets-and-config]] | Secrets & configuration management (env files per level) | accepted |

## Pending ADRs (to write when decided)

- **Auth IdP / provider** — Authentik vs Keycloak vs Zitadel vs equivalent. The strategy is
  decided ([[0016-auth-strategy-deferred]]); only the provider choice remains.
- **Async workers** — BullMQ + Redis (note the [[0009-bun-first-vs-app-stack]] tension:
  BullMQ pulls in `ioredis`, which `CLAUDE.md` discourages).
- **CD / image publishing** — deferred in [[0027-ci-pipeline]]; define the registry (GHCR) +
  deploy flow + image tagging once a deploy target exists.
- **E2E tooling & frontend test runner** — deferred in [[0012-testing-strategy]]; choose when
  UI/critical flows exist.
