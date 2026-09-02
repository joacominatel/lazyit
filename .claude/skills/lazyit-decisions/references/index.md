# ADR index

Generated from the frontmatter of `docs/03-decisions/`. Regenerate when records are
added or their status changes; the files themselves are the source of truth.

Read the record, not the row. A title tells you the subject; the consequences section
tells you what it costs you.

| # | Decision | Status |
| --- | --- | --- |
| 0001 | Monorepo with Bun workspaces + Turborepo | accepted |
| 0002 | NestJS for the backend | accepted |
| 0003 | Prisma as ORM on PostgreSQL | accepted |
| 0004 | Asset-centric domain design | accepted |
| 0005 | Mixed ID strategy (uuid / cuid / autoincrement) | accepted |
| 0006 | Soft delete & append-only auditing | accepted |
| 0007 | Flexible asset specs via jsonb | accepted |
| 0008 | Consumables modeled separately from assets | accepted |
| 0009 | Bun-first guidance vs the chosen app stack | accepted |
| 0010 | Next.js for the frontend | accepted |
| 0011 | Tailwind CSS + shadcn/ui for styling | accepted |
| 0012 | Testing strategy | accepted |
| 0013 | Zod validation via a custom ZodValidationPipe | superseded |
| 0014 | Build @lazyit/shared to CommonJS + declarations | accepted |
| 0015 | Deployment model — self-hosted for IT teams | accepted |
| 0016 | Authentication deferred; external IdP when needed | superseded |
| 0017 | Location type as a hardcoded enum (user-managed types deferred) | accepted |
| 0018 | API documentation with Swagger/OpenAPI (nestjs-zod) | accepted |
| 0019 | AssetAssignment referential integrity & lifecycle | accepted |
| 0020 | Frontend data layer (endpoints → hooks → components) | accepted |
| 0021 | Knowledge Base design — simple wiki | accepted |
| 0022 | Draft visibility & the X-User-Id auth shim | accepted |
| 0023 | Access management design (Application + AccessGrant) | accepted |
| 0024 | Retrofit AssetAssignment actor to the X-User-Id shim | accepted |
| 0025 | Containerization & image strategy | accepted |
| 0026 | Reverse proxy & TLS (Caddy), same-origin /api routing | accepted |
| 0027 | CI on GitHub Actions; CD deferred | accepted |
| 0028 | Secrets & configuration management | accepted |
| 0029 | Untrusted-content sanitization is render-time, not write-time | accepted |
| 0030 | List endpoint pagination contract (offset; implementation deferred) | accepted |
| 0031 | Structured logging strategy (Pino + nestjs-pino) | accepted |
| 0032 | Soft-delete enforcement via a Prisma client extension | accepted |
| 0033 | AssetHistory event model | accepted |
| 0034 | Consumables design (cached stock + append-only movements) | accepted |
| 0035 | Cross-cutting search architecture (Meilisearch) | accepted |
| 0036 | Integer fields bounded to the Postgres int4 range in shared schemas | accepted |
| 0037 | IdP choice — Zitadel, BYOI strategy, own Postgres | accepted |
| 0038 | JIT user provisioning on first OIDC login | accepted |
| 0039 | Auth.js v5 for frontend OIDC login | accepted |
| 0040 | Minimal RBAC — ADMIN / MEMBER / VIEWER role on User | accepted |
| 0041 | Soft-delete reuse — partial unique indexes, restore, citext email | accepted |
| 0042 | Knowledge Base depth — append-only versioning + asset/application linking | accepted |
| 0043 | Zitadel as the identity & authorization source of truth (Option B) | accepted |
| 0044 | Dashboard recent-activity feed backed by a unified DB view | accepted |
| 0045 | Standardize on Heroicons (drop lucide-react) + a two-weight convention | accepted |
| 0046 | Roles & Permissions v2 — fixed roles, configurable permissions (catalog-as-code) | accepted |
| 0047 | Guided first-deploy bootstrap script (infra/start.sh) | accepted |
| 0048 | Service Accounts — a non-human principal with a lazyit-native token + direct permission grants | accepted |
| 0049 | «Activated Restraint» — the design-system activation direction | accepted |
| 0050 | UserHistory append-only log + a `user` entity in the recent-activity feed | accepted |
| 0051 | i18n with next-intl (cookie-mode, en + es) | accepted |
| 0052 | Parallelize CI Docker builds (matrix) and decouple them from verify | accepted |
| 0053 | Async workers — BullMQ on Valkey, with sandboxed processors | accepted |
| 0054 | Applications Workflow Engine — data model & engine foundations | accepted |
| 0055 | On-prem / internal-target connectors — a per-connection audited allowlist | proposed |
| 0056 | In-app notification bell — append-only Notification + per-admin read state (admin-only, v1) | accepted |
| 0057 | Retry-after-fix vs pinned-version replay — how «fix the flow, then retry» should work | accepted |
| 0058 | User identity graph (legajo / username / manager) + clone-with-chosen-actions | accepted |
| 0059 | Knowledge Base v2 — folders, aliases, wiki-links & bulk import | accepted |
| 0060 | Knowledge Base access control — folders as the permission boundary | accepted |
| 0061 | Secret Manager — zero-knowledge vaults beside the Knowledge Base | accepted |
| 0062 | In-app Help / Manual surface — shipped product documentation, distinct from the KB | accepted |
| 0063 | Configurable Asset Tag Scheme — instance config + monotonic counter, OFF by default | accepted |
| 0064 | Admin user provisioning credentials — temporary password only, forced change at first login | accepted |
| 0065 | Secret Manager — regenerate the recovery key for an existing keypair | superseded |
| 0066 | Secret Manager — password is the daily entry credential, recovery key is the root that resets it | accepted |
| 0067 | Server-prefetch + hydration rendering strategy for high-traffic routes | accepted |
| 0068 | Asset Tag Scheme — existing-estate awareness (skip-existing allocation invariant + backfill with preview) | accepted |
| 0069 | Migrator — guided bulk import (phase 1: Asset slice, JSON + CSV) | accepted |
| 0070 | Infra topology graph — a generic visual CMDB of the server estate (InfraNode + InfraEdge) | accepted |
| 0071 | KB write-mode syntax highlighting — overlay over the textarea, not a code-editor replatform | superseded |
| 0072 | Quick View — entity-preview popover in pickers & search | accepted |
| 0073 | Infra node → secret linkage (soft handle-refs, member-scoped attach) | accepted |
| 0074 | Server reporting agent — self-installing Linux collector that auto-reports inventory | accepted |
| 0075 | Typed secrets via client-side structured payload + server-visible `kind` metadata | accepted |
| 0076 | Optional Company grouping field on assets (not a tenancy boundary) | accepted |
| 0077 | «The Ledger» — adopt the landing's design language in the app | accepted |
| 0078 | Advisory per-category specs dictionary (extends ADR-0007) | accepted |
| 0079 | Instance SMTP + outbound email for notifications | proposed |
| 0080 | Programmatic secret retrieval via a service account (headless, client-side decrypt) | accepted |
| 0081 | In-app read + CSV export for the security audit logs | accepted |
| 0082 | File attachments — filesystem volume, API-only serving, deferred backup | accepted |
| 0083 | Tag-driven semver versioning & release automation | accepted |
| 0084 | Update awareness & guided update — check, weekly email, update.sh, UpdateRun | accepted |
| 0085 | Access request flow (request → approve/deny → grant) | accepted |
| 0086 | Local (first-party) authentication mode — make Zitadel/OIDC opt-in | accepted |
| 0087 | Plain-HTTP-on-LAN deployment axis (host-agnostic) + start.sh --reconfigure | accepted |
| 0088 | License / seat tracking on Application (seats + cost + renewal; seatsUsed derived) | accepted |
| 0089 | Bulk receiving + check-out acknowledgement | accepted |
| 0090 | IPAM — validate the node IP as a value, not a string; no IP registry | accepted |
| 0091 | On-prem AD/LDAP as a read-only directory source | accepted |
| 0092 | The Reading Room — KB reading & browsing redesign | accepted |
| 0093 | Chassis routing — adopt an existing Asset by corroborated serial, and keep endpoints off the topology map | proposed |
| 0094 | Assisted agent update — the server names who is behind and hands over the command | proposed |
| 0095 | One hypervisor collector with autodetection — the agent inventories its own guests | proposed |
| 0096 | The api Jest suite stays CommonJS and transpiles the ESM-only NestJS packages | accepted |
