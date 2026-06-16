---
title: Decisions (ADRs) — MOC
tags: [moc, adr]
status: draft
created: 2026-05-25
updated: 2026-06-16
---

<!-- updated 2026-06-01: ADR-0043 (Zitadel source-of-truth) accepted + validated live end-to-end
     (epic delivered; Phase 4 hardening #92/#93/#94/#95 + INVARIANTS). -->
<!-- updated 2026-06-08: ADR-0053 (async workers, BullMQ/Valkey) + ADR-0054 (Applications Workflow
     Engine data model) accepted and shipped on master (epic #248, Phase 1). -->
<!-- updated 2026-06-09: ADR-0055 (on-prem internal-target connectors — proposed, CEO holding the
     build) + ADR-0056 (in-app notification bell — accepted, #313) added as Phase-2 follow-ups to
     ADR-0054 (epic #248). -->
<!-- updated 2026-06-11: ADR-0057 (retry-fix vs pinned-version replay — ACCEPTED 2026-06-11; #340)
     added as a Phase-2 follow-up to ADR-0054 (epic #248); CEO ratified BOTH clone-to-new-run
     (Option 3) + transient payload-override (Option 2), sequence-suffix idempotency key, fail-closed
     double-provision guard. -->
<!-- updated 2026-06-11: ADR-0058 (user identity graph: legajo/username/manager + clone-with-actions —
     ACCEPTED 2026-06-11, #303); the model-first identity layer ADR-0054 §6c deferred. CEO ratified all
     5 proposed defaults: clone does NOT fire the engine by default, offboarded-manager link kept
     (isOffboarded), manager-only scope, username is a directory handle (never a credential), legajo
     unique-among-live. -->
<!-- updated 2026-06-11: ADR-0059/0060/0061 — the Knowledge Base v2 + Secret Manager design session.
     ACCEPTED 2026-06-11 (the decisions stand), but design-only — NO code is built yet. ADR-0059 (KB v2:
     folders evolved from flat ArticleCategory + aliases/symlinks + article↔article [[slug]] wiki-links +
     backlinks + bulk .zip import; #364). ADR-0060 (KB access control: the folder is the permission
     boundary — a deliberate per-folder CARVE-OUT from the per-domain-only rule of ADR-0040/0046; proposes
     INV-9; #365). ADR-0061 (Secret Manager: zero-knowledge vaults beside the KB — per-user-keypair
     envelope, Argon2id, DEK wrapped per member, recovery key shown once; a THIRD secret store distinct
     from the server-decryptable [[workflow-secret]]; new `secret` capability + the INV-8 crypto-exception;
     proposes INV-10; #366). -->
<!-- updated 2026-06-16: ADR-0067 (server-prefetch + hydration rendering strategy — targeted pilot on
     the 6 highest-traffic routes; eliminates skeleton→hydrate→fetch waterfall; keeps TanStack Query
     as client cache; adds loading.tsx + error.tsx coverage; must sequence after #498; resolves
     ADR-0020 deferred debt; #500) — **accepted** (CEO 2026-06-16; implementation deferred to #537). -->
<!-- updated 2026-06-14: ADR batch (docs/adr-batch-jun14). Three new ADRs + two amendments capturing CEO
     decisions already made. ADR-0062 (in-app Help/Manual surface — shipped product docs as repo markdown
     rendered by MarkdownView, **public** (marketing route group, no auth gate) + secret-free, en/es;
     distinct from the KB; EPIC; #454) — **accepted** (CEO 2026-06-16; location/access amendment applied). ADR-0063 (configurable Asset Tag Scheme — lazyit's FIRST instance-config
     store: single-row AssetTagScheme + global monotonic counter, mandatory {num} template, in-transaction
     allocation w/ retry-on-collision, gaps accepted, OFF by default; #363) — **accepted** (CEO 2026-06-14).
     ADR-0064 (admin user provisioning — full-page asset-style create flow; a SECOND, narrower password
     carve-out from ADR-0043: temp-password-only `changeRequired:true`, email auto-verify always-on,
     BYOI hides the controls, reuses `user:manage`; #411) — **accepted** (CEO 2026-06-14). AMENDMENTS:
     ADR-0035 (search reconcile sweeper — periodic unref'd setInterval mirroring the notifications retention
     sweeper, reusing reindexIndex; `SEARCH_RECONCILE_INTERVAL_MS` default hourly; complements reindex:all;
     #383) — accepted (technical). ADR-0056 (targeted per-user notifications — `recipientUserId` distinct
     from `targetUserId`, a non-admin sees their OWN targeted notif without `notification:read` over the
     broadcast set = an AUTH-CONTRACT change; first trigger = login-time vault-setup nudge, dedupeKey
     `secret.vault_setup:<userId>`; ship `/secrets` banner now; #453) — accepted (CEO 2026-06-14). -->

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
| [[0050-user-history-and-activity-user-entity]] | UserHistory append-only log (mirrors AssetHistory, in-transaction) + the User entity in the recent-activity feed (fifth view branch; widens `ActivityEntityType` to `"user"`) | accepted |
| [[0051-i18n-next-intl]] | i18n with next-intl, cookie-mode (no `/es/` prefix), en + es; Phase 0 plumbing + the section-fan-out convention ([[i18n]]) | accepted |
| [[0052-ci-parallel-docker-and-decoupled-verify]] | Parallelize CI Docker builds (matrix) + decouple from `verify`; refines [[0027-ci-pipeline]] | accepted |
| [[0053-async-workers-bullmq-valkey]] | Async workers — BullMQ on Valkey + sandboxed processors (memory-isolated jobs); first job = async `.docx` import (closes SEC-002) | accepted |
| [[0054-applications-workflow-engine]] | Applications Workflow Engine (epic #248) — opt-in per-app provisioning data model on BullMQ-transport + Postgres-as-system-of-record; decoupled from the grant (inverse of INV-5), (trigger, accessGrantId) idempotency, own AES-256-GCM secret store; v1 = REST/WEBHOOK_OUT/MANUAL, public-only | accepted |
| [[0055-on-prem-internal-target-connectors]] | On-prem / internal-target connectors (epic #248, Phase 2) — a per-`WorkflowConnection` audited `host[:port]` allowlist wired to the egress guard's `isInternalTargetAllowed` seam; loopback/IMDS/link-local un-allowlistable by construction; `http`-relax coupled to a non-empty allowlist; gated by a new `workflow:egress`; enables an internal HTTP/REST target, NOT a native LDAP/AD connector | **proposed** (CEO holding the build) |
| [[0056-in-app-notification-bell]] | In-app notification bell (admin-only, v1; #313) — append-only `Notification` + per-admin `NotificationRead` join (fan-out-on-read), closed shared type enum, best-effort post-commit emitters (critical-app/admin-granted/low-stock/manual-task/run-failed), poll delivery (SSE Phase-2 behind the same API), new `notification:read` seeded ADMIN-only; distinct from the `recent_activity` view | accepted |
| [[0057-retry-fix-and-replay]] | Retry-after-fix vs pinned-version replay (#340) — root-cause of «fix the flow, then retry» replaying the pinned version; ships a `workflow:run`-gated **clone-to-new-run from latest** (Option 3, idempotency-guarded, append-only-clean) **and** a transient INV-6-safe **payload-override** on retry (Option 2); sequence-suffix idempotency key `<trigger>:<grantId>:<n>`, fail-closed double-provision guard; automatic per-attempt retry stays deterministic | **accepted** (2026-06-11) |
| [[0058-user-manager-and-clone-actions]] | User identity graph (#303) — new `User` fields `legajo` / `username` (live-only partial unique) + a self-referential `managerId` with a `managerName` free-text fallback (at-most-one CHECK, `SetNull`, cycle-guard); the model-first identity layer ADR-0054 §6c deferred. Plus clone-with-chosen-actions (`POST /users/:id/clone`: opt-in assignments/grants + an explicit, safe-by-default workflow-engine fire toggle). Mapper gains an additive `grantee.manager` token (no migration) | **accepted** (2026-06-11) |
| [[0059-kb-folders-links-and-import]] | Knowledge Base v2 — folders (evolved from flat ArticleCategory) + aliases/symlinks + article↔article `[[slug]]` wiki-links + backlinks + bulk .zip import (extends [[0021-knowledge-base-design]]/[[0042-article-versioning-and-linking]]) | **accepted** (2026-06-11) — **built, merged feat/kb-secrets** |
| [[0060-kb-folder-access-control]] | KB access control — the **folder** is the permission boundary (deliberate per-folder CARVE-OUT from the per-domain-only rule of [[0040-rbac-roles]]/[[0046-roles-permissions-v2]]); default PUBLIC, additive dynamic rules (user/role/app-grant/asset-assignee), composes with draft visibility, ADMIN god-mode, no-escalation, API+DB enforcement | **accepted** (2026-06-11) — **built, merged feat/kb-secrets** |
| [[0061-secret-manager-zero-knowledge]] | Secret Manager — zero-knowledge vaults beside the KB (per-user-keypair envelope, Argon2id, DEK wrapped per member, peer-reset, recovery key shown once, soft-revoke v1); a THIRD secret store distinct from server-decryptable [[workflow-secret]]; new `secret` capability + INV-8 crypto-exception (INV-10). **Terminology refined by [[0066-secret-manager-password-vs-recovery-root]]**: "passphrase" → **vault password** (mutable daily credential); **recovery key** is the root-only reset credential that resets the password (asymmetric roles). | **accepted** (2026-06-11) — **built in #366, merged feat/secret-manager**; terminology superseded in [[0066-secret-manager-password-vs-recovery-root]] |
| [[0062-in-app-help-manual-surface]] | In-app Help / Manual — a fixed, shipped product-documentation surface (repo markdown at `apps/web/content/manual/<locale>/*.md`, frontmatter, rendered by `MarkdownView`), **public** (Next.js `(marketing)` route group, no auth gate) + **secret-free** (respects INV-10 by never touching it), i18n en+es mirroring [[0051-i18n-next-intl]]; **distinct from the KB** ([[0059-kb-folders-links-and-import]]/[[0060-kb-folder-access-control]]); external `docs.lazyit.com` deferred; EPIC; #454 | **accepted** (2026-06-14; public-landing amendment 2026-06-16) |
| [[0063-configurable-asset-tag-scheme]] | Configurable Asset Tag Scheme — lazyit's **FIRST instance-config store**: a single-row `AssetTagScheme` + global monotonic counter, mandatory `{num}` template (+prefix/suffix/padding), in-transaction allocation w/ retry-on-collision (gaps accepted), **OFF by default** (no scheme ⇒ no auto-tag; manual `assetTag` per [[0041-soft-delete-reuse-and-restore]] unchanged); #363 | **accepted** (2026-06-14) |
| [[0064-admin-user-provisioning-credentials]] | Admin user provisioning — full-page asset-style create flow (opt-in assign-asset/app); a **bounded SECOND carve-out** from [[0043-zitadel-source-of-truth]]: **temporary password only** (`changeRequired:true`), email auto-verify always-on, **BYOI hides the controls**, reuses `user:manage` ([[0046-roles-permissions-v2]], no new permission); #411 | **accepted** (2026-06-14) |
| [[0065-secret-manager-regenerate-recovery-key]] | Secret Manager — regenerate the recovery key for an EXISTING keypair (#452, the deferred "regenerate" half): unlock the private key **with the passphrase** client-side → mint a NEW recovery key → re-wrap **only** the recovery-wrapped blob (`privateKeyEncByRecovery`/`recoverySalt`/`recoveryIv`); public key, per-vault DEKs, and all [[vault-membership]] UNCHANGED (no DEK re-wrap, no membership churn — the non-destructive alternative to peer-reset). New self-only `POST /secret-manager/keypair/recovery`; shown-once (reuses #452/PR #457 ordering); **INV-10 preserved** (server stays ciphertext custodian, can't validate the blob). "Lost BOTH passphrase + recovery key" on a single-member vault = still permanent loss (by design). Extends [[0061-secret-manager-zero-knowledge]] | **superseded by [[0066-secret-manager-password-vs-recovery-root]]** (2026-06-15) |
| [[0066-secret-manager-password-vs-recovery-root]] | Secret Manager — password is the daily entry credential, recovery key is the root that resets it (ADR-0066): renames the "passphrase" to **vault password** (mutable, user-changeable); elevates the **recovery key** as the root-only reset credential (shown once, used only when password is lost); clarifies that `POST /secret-manager/keypair/recovery` changes the password, not the recovery key; supersedes the locked-in terminology of [[0065-secret-manager-regenerate-recovery-key]] | **accepted** (2026-06-15) — built in #526/#527 + frontend #528 |
| [[0067-server-prefetch-ssr-strategy]] | Server-prefetch + hydration rendering strategy — targeted pilot on the 6 highest-traffic routes (`/dashboard` + 5 entity list pages): thin async Server Component pages using `prefetchQuery` + `dehydrate` + `<HydrationBoundary>` (TanStack Query v5); eliminates the skeleton→hydrate→fetch waterfall; keeps TanStack Query as the client cache; adds group-level `loading.tsx` + per-group `error.tsx`; must sequence after #498 (session-seeding fix); builds on [[0039-authjs-v5-frontend-oidc]] §6a; resolves the deferred debt noted in [[0020-frontend-data-layer]]; #500 | **accepted** (2026-06-16, CEO ratification; implementation deferred to #537) |
| [[0068-asset-tag-existing-estate-awareness]] | Asset Tag Scheme — existing-estate awareness (extends [[0063-configurable-asset-tag-scheme]]): a **skip-existing allocation invariant** (an auto-tag is NEVER a tag that already exists on a live asset — the counter always advances to the next free rendered tag, by construction + the `assets_assetTag_active_key` index for races; no false 409 under dense occupancy), a **seed suggestion** (`startNumber = max(existing matching)+1`), and an explicit **backfill** (`settings:manage`) with a **read-only paginated preview** (AssetModel filter + per-row deselect) + two modes — default `untagged-only`, opt-in `normalize-non-conforming` behind a warning — forward-only & audited via `AssetHistory` ([[0006-soft-delete-and-auditing]]); #547 | **accepted** (2026-06-16) |

> **Amendments in this batch (no renumber):** [[0035-search-architecture]] gains a **periodic
> drift-reconcile sweeper** (unref'd `setInterval` mirroring the notifications retention sweeper, reusing
> `reindexIndex`; `SEARCH_RECONCILE_INTERVAL_MS`, default hourly; complements `reindex:all`; #383) —
> *accepted (technical)*. [[0056-in-app-notification-bell]] gains **targeted per-user notifications**
> (`recipientUserId` ≠ `targetUserId`; a non-admin sees their OWN targeted notification without
> `notification:read` over the admin broadcast set — an **auth-contract change**; first trigger = the
> login-time vault-setup nudge, dedupeKey `secret.vault_setup:<userId>`; + ship the `/secrets` banner now;
> #453) — *accepted (CEO 2026-06-14)*.

## Pending ADRs (to write when decided)
- **CD / image publishing** — deferred in [[0027-ci-pipeline]]; define the registry (GHCR) +
  deploy flow + image tagging once a deploy target exists.
- **E2E tooling & frontend test runner** — deferred in [[0012-testing-strategy]]; choose when
  UI/critical flows exist.
