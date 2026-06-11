---
title: Decisions (ADRs) — MOC
tags: [moc, adr]
status: draft
created: 2026-05-25
updated: 2026-06-11
---

<!-- updated 2026-06-01: ADR-0043 (Zitadel source-of-truth) accepted + validated live end-to-end
     (epic delivered; Phase 4 hardening #92/#93/#94/#95 + INVARIANTS). -->
<!-- updated 2026-06-08: ADR-0053 (async workers, BullMQ/Valkey) + ADR-0054 (Applications Workflow
     Engine data model) accepted and shipped on master (epic #248, Phase 1). -->
<!-- updated 2026-06-09: ADR-0055 (on-prem internal-target connectors — proposed, CEO holding the
     build) + ADR-0056 (in-app notification bell — accepted, #313) added as Phase-2 follow-ups to
     ADR-0054 (epic #248). -->
<!-- updated 2026-06-11: ADR-0057 (retry-fix vs pinned-version replay — proposed, awaiting CEO
     decision; #340) added as a Phase-2 follow-up to ADR-0054 (epic #248). -->

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
| [[0016-auth-strategy-deferred]] | Authentication deferred; external IdP when needed | superseded by [[0037-idp-choice-zitadel-byoi]] / [[0039-authjs-v5-frontend-oidc]] (auth implemented) |
| [[0017-location-type-enum]] | Location type as a hardcoded enum (user-managed types deferred) | accepted |
| [[0018-api-documentation-swagger]] | API documentation with Swagger/OpenAPI (nestjs-zod) | accepted |
| [[0019-asset-assignment-integrity]] | AssetAssignment referential integrity & lifecycle | accepted (actor source superseded by [[0024-asset-assignment-actor-shim]]) |
| [[0020-frontend-data-layer]] | Frontend data layer (endpoints → hooks → components) | accepted |
| [[0021-knowledge-base-design]] | Knowledge Base design — simple wiki (Article + ArticleCategory) | accepted |
| [[0022-draft-visibility-auth-shim]] | Draft visibility & the `X-User-Id` auth shim | accepted (shim path preserved; actor source superseded in OIDC path by [[0038-jit-user-provisioning]]) |
| [[0023-access-management-design]] | Access management design (Application + AccessGrant) | accepted (actor source superseded in OIDC path by [[0038-jit-user-provisioning]]) |
| [[0024-asset-assignment-actor-shim]] | Retrofit AssetAssignment actor to the `X-User-Id` shim | accepted (actor source superseded in OIDC path by [[0038-jit-user-provisioning]]) |
| [[0025-containerization-strategy]] | Containerization & image strategy (Bun build → Node runtime) | accepted |
| [[0026-reverse-proxy-tls]] | Reverse proxy & TLS (Caddy), same-origin `/api` routing | accepted |
| [[0027-ci-pipeline]] | CI on GitHub Actions; CD deferred | accepted |
| [[0028-secrets-and-config]] | Secrets & configuration management (env files per level) | accepted |
| [[0029-untrusted-content-sanitization]] | Untrusted-content sanitization is render-time, not write-time | accepted |
| [[0030-list-pagination-contract]] | List endpoint pagination contract (offset; implementation deferred) | accepted |
| [[0031-logging-strategy]] | Structured logging strategy (Pino + nestjs-pino) | accepted |
| [[0032-soft-delete-middleware]] | Soft-delete enforcement via a Prisma client extension | accepted |
| [[0033-asset-history-event-model]] | AssetHistory event model (discrete events, explicit emission) | accepted |
| [[0034-consumables-design]] | Consumables design (cached stock + append-only movements) | accepted |
| [[0035-search-architecture]] | Cross-cutting search architecture (Meilisearch) | accepted |
| [[0036-int4-bounded-integers]] | Integer fields bounded to the Postgres int4 range in shared schemas | accepted |
| [[0037-idp-choice-zitadel-byoi]] | IdP choice — Zitadel, BYOI strategy, own Postgres | accepted (extended by [[0043-zitadel-source-of-truth]]) |
| [[0038-jit-user-provisioning]] | JIT user provisioning on first OIDC login | accepted (extended by [[0043-zitadel-source-of-truth]]) |
| [[0039-authjs-v5-frontend-oidc]] | Auth.js v5 for frontend OIDC login | accepted |
| [[0040-rbac-roles]] | Minimal RBAC — ADMIN/MEMBER/VIEWER role on User | accepted (default-role + bootstrap extended by [[0043-zitadel-source-of-truth]]; authZ MECHANISM superseded by [[0046-roles-permissions-v2]] — the 3 roles stay fixed) |
| [[0042-article-versioning-and-linking]] | KB depth — append-only ArticleVersion + article↔asset/application linking + content search | accepted |
| [[0043-zitadel-source-of-truth]] | Zitadel as the identity & authorization source of truth (Option B) | accepted |
| [[0044-recent-activity-view]] | Dashboard recent-activity feed backed by a unified `recent_activity` DB view | accepted |
| [[0045-icon-library-heroicons]] | Standardize web on Heroicons (drop lucide-react) + a two-weight convention (24/outline default, 16/solid dense) | accepted |
| [[0046-roles-permissions-v2]] | Roles & Permissions v2 — fixed roles + configurable permissions (catalog-as-code); supersedes the ADR-0040 authZ mechanism | accepted |
| [[0047-guided-first-deploy-bootstrap]] | Guided, idempotent, non-destructive first-deploy bootstrap (`infra/start.sh`) — a thin wrapper over the env contract + prod compose | accepted |
| [[0048-service-accounts]] | Service Accounts — a non-human principal with a lazyit-native token + direct permission grants (fail-closed; never a Role/ADMIN); extends ADR-0040/0043/0046 | accepted |
| [[0049-activated-restraint-ux-direction]] | «Activated Restraint» — design-system activation: motion vocabulary + warm elevation scale + pillar colour family + the AA rule (pillar hue = tint/border/dot/chip, never small text); extends ADR-0011 | accepted |
| [[0051-i18n-next-intl]] | i18n with next-intl, cookie-mode (no `/es/` prefix), en + es; Phase 0 plumbing + the section-fan-out convention ([[i18n]]) | accepted |
| [[0052-ci-parallel-docker-and-decoupled-verify]] | Parallelize CI Docker builds (matrix) + decouple from `verify`; refines [[0027-ci-pipeline]] | accepted |
| [[0053-async-workers-bullmq-valkey]] | Async workers — BullMQ on Valkey + sandboxed processors (memory-isolated jobs); first job = async `.docx` import (closes SEC-002) | accepted |
| [[0054-applications-workflow-engine]] | Applications Workflow Engine (epic #248) — opt-in per-app provisioning data model on BullMQ-transport + Postgres-as-system-of-record; decoupled from the grant (inverse of INV-5), (trigger, accessGrantId) idempotency, own AES-256-GCM secret store; v1 = REST/WEBHOOK_OUT/MANUAL, public-only | accepted |
| [[0055-on-prem-internal-target-connectors]] | On-prem / internal-target connectors (epic #248, Phase 2) — a per-`WorkflowConnection` audited `host[:port]` allowlist wired to the egress guard's `isInternalTargetAllowed` seam; loopback/IMDS/link-local un-allowlistable by construction; `http`-relax coupled to a non-empty allowlist; gated by a new `workflow:egress`; enables an internal HTTP/REST target, NOT a native LDAP/AD connector | **proposed** (CEO holding the build) |
| [[0056-in-app-notification-bell]] | In-app notification bell (admin-only, v1; #313) — append-only `Notification` + per-admin `NotificationRead` join (fan-out-on-read), closed shared type enum, best-effort post-commit emitters (critical-app/admin-granted/low-stock/manual-task/run-failed), poll delivery (SSE Phase-2 behind the same API), new `notification:read` seeded ADMIN-only; distinct from the `recent_activity` view | accepted |
| [[0057-retry-fix-and-replay]] | Retry-after-fix vs pinned-version replay (#340) — root-cause of «fix the flow, then retry» replaying the pinned version; recommends a `workflow:run`-gated **clone-to-new-run from latest** (idempotency-guarded, append-only-clean) over in-place re-pin / transient payload-override; automatic per-attempt retry stays deterministic | **proposed** (awaiting CEO decision) |

## Pending ADRs (to write when decided)
- **CD / image publishing** — deferred in [[0027-ci-pipeline]]; define the registry (GHCR) +
  deploy flow + image tagging once a deploy target exists.
- **E2E tooling & frontend test runner** — deferred in [[0012-testing-strategy]]; choose when
  UI/critical flows exist.
