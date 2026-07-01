---
title: Decisions (ADRs) — MOC
tags: [moc, adr]
status: draft
created: 2026-05-25
updated: 2026-06-23
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
     ADR-0020 deferred debt; #500) — **accepted** (CEO 2026-06-16); pilot implemented 2026-06-20 (#537). -->
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
| [[0038-jit-user-provisioning]] | JIT user provisioning on first OIDC login | accepted (extended by [[0043-zitadel-source-of-truth]]; amended 2026-06-20: directory-person promotion on JIT claim + manual `provision-account` path) |
| [[0039-authjs-v5-frontend-oidc]] | Auth.js v5 for frontend OIDC login | accepted |
| [[0040-rbac-roles]] | Minimal RBAC — ADMIN/MEMBER/VIEWER role on User | accepted (default-role + bootstrap extended by [[0043-zitadel-source-of-truth]]; authZ MECHANISM superseded by [[0046-roles-permissions-v2]] — the 3 roles stay fixed) |
| [[0041-soft-delete-reuse-and-restore]] | Soft-delete reuse — partial unique indexes, restore, citext email | accepted |
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
| [[0067-server-prefetch-ssr-strategy]] | Server-prefetch + hydration rendering strategy — targeted pilot on the 6 highest-traffic routes (`/dashboard` + 5 entity list pages): thin async Server Component pages using `prefetchQuery` + `dehydrate` + `<HydrationBoundary>` (TanStack Query v5); eliminates the skeleton→hydrate→fetch waterfall; keeps TanStack Query as the client cache; adds group-level `loading.tsx` + per-group `error.tsx`; must sequence after #498 (session-seeding fix); builds on [[0039-authjs-v5-frontend-oidc]] §6a; resolves the deferred debt noted in [[0020-frontend-data-layer]]; #500 | **accepted** (2026-06-16); pilot implemented 2026-06-20 (#537) |
| [[0068-asset-tag-existing-estate-awareness]] | Asset Tag Scheme — existing-estate awareness (extends [[0063-configurable-asset-tag-scheme]]): a **skip-existing allocation invariant** (an auto-tag is NEVER a tag that already exists on a live asset — the counter always advances to the next free rendered tag, by construction + the `assets_assetTag_active_key` index for races; no false 409 under dense occupancy), a **seed suggestion** (`startNumber = max(existing matching)+1`), and an explicit **backfill** (`settings:manage`) with a **read-only paginated preview** (AssetModel filter + per-row deselect) + two modes — default `untagged-only`, opt-in `normalize-non-conforming` behind a warning — forward-only & audited via `AssetHistory` ([[0006-soft-delete-and-auditing]]); #547 | **accepted** (2026-06-16) |
| [[0069-migrator-import]] | Guided bulk import — phase 1 (Asset slice, JSON + CSV) with Etapa-2 amendment: directory persons (`directoryOnly` User mode) + AssetAssignment + specs passthrough | **accepted** (2026-06-17); amended 2026-06-20 (Etapa 2: §A.1–A.5) |
| [[0070-infra-topology-graph]] | Infra topology graph — a generic visual CMDB of the server estate: `InfraNode` (generic extensible kinds, Asset-backed by default with a per-node opt-out) + `InfraEdge` (timestamped typed join per [[0019-asset-assignment-integrity]]'s pattern: RUNS_ON/MEMBER_OF/DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO); a React Flow free-move canvas surfacing owner/KB/secrets/shortcuts per node; **servers-only** (no employee graph); **platform-agnostic** (k8s/Proxmox/cloud/backups are stress-tests, NOT built-in concepts); phased MVP→v1 (impact/blast-radius + Meili + `infra:read`/`infra:manage`)→v2 (installable reporting agent, own major, ADR-0048 auth)→future; #723 [major] | **accepted** (2026-06-23) — MVP+v1 built & merged on `feat/topology` (canvas, drill-in panel, Servers list, impact/blast-radius UI, Meili search); v2 agent + #750 (list asset enrichment) + asset→secret linkage deferred |
| [[0071-kb-write-mode-syntax-highlighting]] | KB write-mode syntax highlighting — colour the markdown **source** as you type (headings/emphasis/lists/code/links + the `[[`/`{{` reserved tokens) via a hand-rolled overlay: the exact ADR-0021 `<textarea>` (transparent text, visible caret) layered over a scroll-synced highlighted `<pre>`; reuses the already-installed `react-syntax-highlighter` hljs `markdown` grammar (**zero new deps**) with an «Activated Restraint» source palette; both `[[`/`{{` autocompletes and the preview/sanitiser untouched by construction. Rejected CodeMirror replatform (reverses ADR-0021) and `react-simple-code-editor` (hides the textarea ref, owns undo). #736 | **accepted** (2026-06-24) |
| [[0072-quick-view-entity-preview]] | Quick View — an entity-preview popover surfaced by a per-row **eye** in the pickers & search. Built on the existing radix **Popover** (NOT HoverCard/Tooltip — not vendored, can't pin/keyboard); controlled `open`+`pinned`; reuses `DetailField`/status badges/`UserAvatar`. **Reuses the in-memory list row the picker ALREADY loaded — zero extra fetch** (the rows are a rich superset of the preview; gaps omitted, never backfilled; the palette alone lazily fetches-on-open in wave 3). a11y: real focusable eye (revealed on hover OR cmdk-selected row, Enter/Space pins, Escape returns focus), real `<dl>` grid, dialog-when-pinned; motion reuses the ~100ms Popover anims (ADR-0049, reduced-motion via the global guard); INV-10 (no secret values) + SEC-008 (`isSafeApplicationUrl` plain-text url) honoured. Epic #788; wave 1 (#789): primitive + `combobox.tsx` seam + 5/6 wrappers (category omitted — its row IS the label) | **accepted** (2026-06-24) — wave 1 built #789; waves 2 (#790 multi-select) / 3 (#791 palette) pending |
| [[0073-infra-node-secret-linkage]] | Infra node → secret linkage — pin "this node uses *these* secrets" on the topology drill-in via a soft handle-ref join (`InfraNodeSecretRef`: `vaultId` + `handle`, **no FK** to the zero-knowledge `SecretItem`, mirroring KB chips + `SecretAuditLog`; resolved to live metadata at read, dangling dropped). Metadata only (handle/label/vaultId) — INV-10 intact. Discrete `POST`/`DELETE /infra/nodes/:id/secrets` (member-scoped attach), authz attach=`infra:manage`+`secret:read`+HumanOnly+live `VaultMembership`, detach=`infra:manage`. #801 | **accepted** (2026-06-27) |
| [[0074-server-reporting-agent]] | Server reporting agent — a self-installing **Linux** Bun-compiled collector that auto-reports **inventory only** (hardware + installed software, **self-host only**, no metrics/scanning) to the operator's **own** instance, filling the v2 columns [[0070-infra-topology-graph]] reserved (`source=AGENT`/`state=PENDING`/`reportingSource`/`externalId`/`lastReportedAt`). `POST /infra/report` (SA auth, new single perm `infra:report`), upsert/reconcile by `(reportingSource, externalId)`=`/etc/machine-id` (adds the deferred composite unique index), **PENDING review tray** (human confirms → backing Asset), staleness sweeper (stale `lastReportedAt` → OFFLINE). Distribution: `install.sh` public via web + binary token-gated via API, **baked into the Docker image** (`bun build --compile`, no GitHub Release), one-liner reusing the SA token reveal. Epic #831 | **accepted** (2026-06-27) — design fixed pre-build; phases 1-3 tracked in #831 |
| [[0076-asset-company-grouping-field]] | Optional **Company** grouping field on `Asset` (Snipe-IT-style) — an optional free-text `company String?` column to **group/filter/report** assets, **NOT** per-record tenancy/scoping (Modo B rejected, #841): anyone with `asset:read` still sees ALL assets, no RBAC/read-scoping change ([[0015-deployment-model]] single-org + [[0046-roles-permissions-v2]] global capabilities intact). **Free-text + autocomplete** over already-used values (`GET /assets/companies`) — no Company entity/table/CRUD. Mirrors the optional `notes` attribute end-to-end (shared zod, create/update, list filter, clone, bulk import `Company`/`Empresa` column). ponytail: promote to a managed Company entity only if rename/soft-delete governance is ever needed. #857 | **accepted** (2026-06-28) |
| [[0077-ledger-design-language-frontend-refactor]] | «The Ledger» — adopt the landing's design language in the app, resolving the **landing↔app visual discrepancy**: pure-neutral **paper/carbon** surfaces (kill the warm `bone`), **oxblood** brand (replaces indigo) + green *verify*, **Hanken Grotesk + Commit Mono** (Redaction display, sparingly). The product **is** a system of record, so the record/stamp/audit-tape vocabulary is the product made UI. **Tokens-first** shadcn value-swap (keep names → cascades app-wide) → ledger-native patterns (status→**stamp**, audit→**tape**, history→**timeline**) → per-screen polish. Brand→product **register translation** (no manifesto voice, no Redaction in dense UI, stamps = status only). **Revises palette+type** of [[0049-activated-restraint]] (restraint kept). Validate with a 1-screen **spike** (asset+history) first. NO app code yet — docs only. Companion: [[ledger-design-language]]. #863, branch `refac/frontend-design` | **proposed** (2026-06-29) |
| [[0075-typed-secrets-client-payload-kind-metadata]] | Typed secrets (SSH key / TOTP / certificate) — a "typed secret" is a **client-side JSON payload** serialized into the **same opaque ciphertext** the server already can't decrypt (INV-10 intact). The ONLY backend change is an additive server-visible `SecretItem.kind` enum `{ GENERIC SSH_KEY TOTP CERTIFICATE }` (`@default(GENERIC)`, metadata only, same trust class as `handle`/`label`) so the UI picks the form/icon/renderer **without decrypting**. No crypto-path change, no typed value column, no server-side payload validation; legacy + omitted = `GENERIC` (plain string). `kind` is mutable (re-typing). Per-`kind` payload shapes are a client-only contract. #838 | **accepted** (2026-06-28) |
| [[0080-service-account-secret-retrieval]] | **Programmatic secret retrieval via a service account** (headless, client-side decrypt) — extends [[0061-secret-manager-zero-knowledge]] + [[0048-service-accounts]]. An SA becomes **another keypair holder**: a browser generates its X25519 keypair on SA creation and wraps the private key ONCE under `Argon2id(SA token secret)` (the token plays the human passphrase's role; NO recovery copy — loss = rotate). A **dedicated `ServiceAccountKeypair` + `ServiceAccountVaultMembership`** pair (never a user/SA union). A human member re-wraps the vault DEK to the SA pubkey via the **existing grant flow** ("no grant-what-you-can't-read" holds). A **service-only** `GET /secret-fetch/:vaultId` (new narrow verb **`secret:fetch`**; `ServiceOnlyGuard`; `secret:read`/`:manage` stay SA-ungrantable) returns **ciphertext + the SA's wrapped keys ONLY** — the **`lazyit-fetch` CLI** (`packages/fetch-cli`) re-derives the KEK, unwraps priv→DEK→values and emits a `.env`. **INV-10 intact** (server never decrypts; DB dump = ciphertext; the INV-10 merge gate pins the new path). Every read audited (`ITEMS_FETCHED`, SA actor). **Token-as-keymaster residual ACCEPTED** (per-vault scope, audit, rotate). #614 | **accepted** (2026-07-01) |
| [[0079-instance-smtp-outbound-email]] | Instance **SMTP + outbound email** — a singleton `SmtpSettings` config store (mirrors [[0063-configurable-asset-tag-scheme]]; `settings:manage`, `GET`/`PUT`/`POST test` at `/config/smtp`) unlocks an **email CHANNEL behind `NotificationsService.emit()`** ([[0056-in-app-notification-bell]]). The SMTP **password is a SERVER-managed credential** (inverse of INV-10 Secret Manager): AES-256-GCM at rest (the `WorkflowSecret` envelope shape, `node:crypto`) under a **new OPTIONAL key `SMTP_SECRET_KEY`** (own axis; required only to save a password → 409), **write-only** on the wire (`passwordSet`). Delivery **enqueues on BullMQ** ([[0053-async-workers-bullmq-valkey]]), **fail-soft** (email never breaks the bell/request). A **global on/off** + a flat **allowlist** (7 types: `critical_app_access`, `admin_granted`, `low_stock`, `workflow.manual_task`, `workflow.run_failed` + the sensitive-audit `permission_widened` + `infra.agent_offline`, CEO opt-in 2026-06-30) — NO rules engine; audience mirrors the bell. ONE branded multipart template; a real **"send test email"** action. **No per-user opt-out in v1** (the "reuse existing prefs" premise was false — none exist). Webhook/Slack = follow-up. #615 | **proposed** (2026-06-30) |

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
