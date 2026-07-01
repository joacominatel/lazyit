# Decision History

> This document is a **CTO-friendly index of major decisions** taken across the project — ADRs and broader strategic calls. It exists to let the CTO quickly check "is this already decided?" without reading thirty ADR files.
>
> **Owner**: CTO. Updated when a new ADR is accepted, or when a non-ADR strategic decision lands in a session.
>
> Initially populated: 2026-05-26 (first CTO session), from all 36 ADRs in `docs/03-decisions/`.
> Refreshed 2026-06-01 (post auth epic) — covered all 44 ADRs (0001–0044).
> Refreshed 2026-06-01 (post UX northstar cycle, PRs #100–#115) — now covers all 45 ADRs (0001–0045; ADR-0045 = heroicons) + the ADR-0011/0030 amendments.
> Refreshed 2026-06-03 (post RBAC v2 + Service-Accounts epic) — now covers all 48 ADRs (0001–0048; ADR-0046 = Roles & Permissions v2, ADR-0047 = `start.sh`, ADR-0048 = Service Accounts). Read-authorization is now CLOSED; `@Roles` retired in favor of `@RequirePermission`.
> Refreshed 2026-07-01 (CTO memory refresh) — now covers all **81 ADRs (0001–0081)**. Added 0049–0081 as a chronological continuation block below (§"Index continued — ADRs 0049–0081"). Headline arc since 0048: async workers (BullMQ/Valkey, 0053) + Workflow Engine (0054/0055/0057) + Secret Manager zero-knowledge (0061/0065/0066/0075/0080) + Infra topology CMDB (0070/0073) + the Linux reporting agent (0074) + KB v2 folders/ACL (0059/0060) + i18n en/es (0051) + in-app Help/Manual (0062) + the "Ledger" design refactor (0077) + instance SMTP (0079, *proposed*) + the audit read surface (0081). New invariants: **INV-9** (KB folder ACL, ADR-0060) + **INV-10** (Secret Manager server-never-decrypts, ADR-0061).

---

## How to use this file

When designing a plan or considering an escalation, the CTO scans this file for:
- Decisions that constrain the task (must follow X)
- Decisions that have been superseded (don't follow Y; we changed our mind)
- Decisions deferred (don't try to settle Z; it's parked deliberately)

---

## Index of major decisions

### Architecture

**ADR-0001** — *Monorepo with Bun workspaces + Turborepo*
**Status**: accepted
**One-liner**: single repo; Bun workspaces for packages; Turborepo for build orchestration.
**CTO note**: tooling is Bun; don't introduce npm/yarn/pnpm/npx.

---

**ADR-0002** — *NestJS for the backend*
**Status**: accepted
**One-liner**: NestJS (Express) for the API; opinionated structure, mature, domain-friendly.
**CTO note**: backend agents work within NestJS module conventions; no raw Express handlers.

---

**ADR-0003** — *Prisma as ORM on PostgreSQL*
**Status**: accepted
**One-liner**: Prisma schema-first ORM; `@prisma/adapter-pg`; `moduleFormat = "cjs"` for NestJS.
**CTO note**: schema changes require `bunx prisma migrate dev`; generated client at `apps/api/generated/prisma`.

---

**ADR-0009** — *Bun-first guidance vs the chosen app stack*
**Status**: accepted
**One-liner**: Bun for tooling/scripts/shared package; NestJS + Prisma + Jest for the app layer.
**CTO note**: never replace NestJS with `Bun.serve`, Prisma with `Bun.sql`, or Jest with `bun test` in `apps/api`.

---

**ADR-0010** — *Next.js for the frontend*
**Status**: accepted
**One-liner**: Next.js App Router + React; server components where they help.
**CTO note**: App Router; no Pages Router patterns.

---

**ADR-0011** — *Tailwind CSS + shadcn/ui for styling*
**Status**: accepted — **amendment 3 (2026-06)**: the semantic tokens were activated/tuned
**One-liner**: Tailwind v4 + shadcn/ui (`radix-nova`, `neutral` base).
**CTO note**: amendment 3 (#102) **activated + tuned** `--success/--warning/--info` (+fg) for AA contrast on the bone canvas (solid pills, light + dark) and repurposed `--chart-1..5` as the categorical/avatar palette. The lucide-vs-heroicons icon rule moved to its own ADR-0045 (lucide is now fully dropped).

---

**ADR-0045** — *Standardize on Heroicons (drop lucide-react) + a two-weight convention*
**Status**: accepted (2026-06-01)
**One-liner**: app standardizes on **@heroicons only**; `lucide-react` removed entirely (the 6 vendored shadcn primitives + sonner re-skinned); two-weight convention — `24/outline` default + `16/solid` inline.
**CTO note**: a deliberate divergence from shadcn's lucide default — heroicons was chosen for least churn. There is now **no lucide anywhere** in the tree (the old "lucide only inside `components/ui/*`" carve-out is gone). Annotated ADR-0011 + code-conventions.

---

**ADR-0014** — *Build @lazyit/shared to CommonJS + declarations*
**Status**: accepted
**One-liner**: shared package emits CJS + `.d.ts` so NestJS (CJS) and Next.js can consume it.
**CTO note**: `@lazyit/shared` must be built before typecheck/test in CI; never import its source directly.

---

**ADR-0018** — *API documentation with Swagger/OpenAPI (nestjs-zod)*
**Status**: accepted (supersedes ADR-0013)
**One-liner**: Swagger UI at `/api/docs`; `nestjs-zod` + `createZodDto` for type-safe DTOs and validation.
**CTO note**: ADR-0013 (custom ZodValidationPipe) is superseded. All endpoints use `createZodDto`; global `ZodValidationPipe`.

---

**ADR-0020** — *Frontend data layer (endpoints → hooks → components)*
**Status**: accepted
**One-liner**: `lib/api/endpoints/*.ts` → `lib/api/hooks/*.ts` → pages/components. Never call endpoints directly from components.
**CTO note**: validated on 4+ screens. `crud-endpoints.ts` factory for standard CRUD; `query-keys.ts` factory per entity.

---

**ADR-0025** — *Containerization & image strategy (Bun build → Node runtime)*
**Status**: accepted
**One-liner**: Multi-stage Docker images; Bun for build, Node for runtime in prod.
**CTO note**: three Dockerfiles in `infra/docker/`. DevOps owns Dockerfile changes.

---

**ADR-0026** — *Reverse proxy & TLS (Caddy), same-origin `/api` routing*
**Status**: accepted
**One-liner**: Caddy as the only public-facing service; `/api` proxied to API, `/` to web.
**CTO note**: `NEXT_PUBLIC_API_URL=/api` baked at build time — relative path, domain-portable (ADR-0026).

---

**ADR-0027** — *CI on GitHub Actions; CD deferred*
**Status**: accepted
**One-liner**: CI: typecheck, lint (non-blocking), tests, build, docker images. No CD yet.
**CTO note**: lint is `continue-on-error: true` until codebase is lint-clean. CD ADR pending.

---

**ADR-0028** — *Secrets & configuration management (env files per level)*
**Status**: accepted
**One-liner**: one `.env` per scope (root for Postgres, `apps/api/.env`, `infra/env/.env.prod`); committed `.env.example` only.
**CTO note**: no secrets in code; always add to `.env.example` first.

---

**ADR-0047** — *`start.sh` — guided first-deploy bootstrap*
**Status**: accepted (2026-06-03)
**One-liner**: a single guided, **idempotent, non-destructive** `start.sh` entry point for first deploy — generates/validates `.env.prod`, brings up the prod profile, and walks the operator to the `/setup` wizard. Safe to re-run.
**CTO note**: DevOps lane. Pairs with the zero-touch Zitadel sidecars (ADR-0043) and the `/setup` wizard — closes the "operator doesn't know where to start" gap for a self-hosted product. Idempotent = re-running never destroys data.

---

**ADR-0035** — *Cross-cutting search architecture (Meilisearch)*
**Status**: accepted
**One-liner**: Meilisearch for unified cross-entity search; service-layer sync (fire-and-forget); fail-soft.
**CTO note**: Meilisearch now in both dev and prod compose (PR #38). `GET /search?q=&entities=&limit=20`.

---

**ADR-0037** — *IdP choice (Zitadel) + BYOI pattern*
**Status**: accepted (2026-05-27) → **extended by ADR-0043** (§6 manual OIDC-client registration replaced by the sidecar+wizard as primary path; manual runbook kept as BYOI/fallback)
**One-liner**: Zitadel as bundled default OIDC IdP; its own Postgres; BYOI via 3 env vars (OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET).
**CTO note**: backend speaks generic OIDC — zero Zitadel-specific code on the authN path (Management-API coupling is opt-in, lives only in the Zitadel adapter — ADR-0043). Caddy routes `auth.{LAZYIT_DOMAIN}` → Zitadel. The 3-env-var BYOI envelope survives ADR-0043. CEO decisions: own Postgres for Zitadel (clean removal path), BYOI is load-bearing.

---

**ADR-0038** — *JIT user provisioning on first OIDC login*
**Status**: accepted (2026-05-27) → **extended by ADR-0043** (roles now WRITE BACK to Zitadel — the old "roles never sync to the IdP" posture is reversed; the reverse, token-role→authZ, is explicitly NOT adopted)
**One-liner**: auto-provision User from OIDC claims on first login; assumes trusted IdP; no pre-registration in lazyit needed.
**CTO note**: CEO chose Option 1 (auto-provision). **Account-linking by verified email** (claim a live `externalId IS NULL` row, never re-bind a different `sub`, never resurrect soft-deleted — INV-2) was added; non-first JIT default flipped MEMBER→VIEWER (ADR-0043), first-ever stays ADMIN. Guard uses `jose` (RS256-pinned), no Passport. `AUTH_MODE=shim` retained for dev/tests (prod-guarded).

---

**ADR-0039** — *Auth.js v5 for frontend OIDC login*
**Status**: accepted (2026-05-27)
**One-liner**: Auth.js v5 with a generic OIDC provider for the web; HTTP-only cookie session; Bearer injection to the API via the `session-token` store.
**CTO note**: BYOI-compatible (generic OIDC provider config); App Router native. The `UserSwitcher`/`acting-user.ts` dev shim was removed when this landed.

---

### Domain

**ADR-0004** — *Asset-centric domain design*
**Status**: accepted
**One-liner**: Asset is the first-class citizen; ownership is a timestamped join (AssetAssignment), not a column.
**CTO note**: pushing back against user-centric features is the CTO's job.

---

**ADR-0005** — *Mixed ID strategy (uuid / cuid / autoincrement)*
**Status**: accepted
**One-liner**: `User.id` = uuid (sensitive/exposed); domain entities = cuid; logs/history = autoincrement.
**CTO note**: new entities default to cuid unless they need uuid (user-facing exposure) or autoincrement (log tables, never exposed).

---

**ADR-0006** — *Soft delete & append-only auditing*
**Status**: accepted
**One-liner**: mutable entities have `deletedAt`; append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement) never soft-delete.
**CTO note**: append-only tables use `releasedAt`/`revokedAt` lifecycle markers instead.

---

**ADR-0007** — *Flexible asset specs via jsonb*
**Status**: accepted
**One-liner**: `Asset.specs`, `AssetModel.specs`, `Article.metadata` are `Json?` (jsonb); app-level validation via zod.
**CTO note**: `specs` fields are intentional flexibility debt — validated by the frontend as loose schemas. Don't tighten the Prisma type.

---

**ADR-0008** — *Consumables modeled separately from assets*
**Status**: accepted
**One-liner**: Consumable (stock-counted) vs Asset (individually tracked) are distinct entities.
**CTO note**: cables, toner, adapters = Consumable; laptops, servers = Asset. Don't conflate.

---

**ADR-0012** — *Testing strategy*
**Status**: accepted
**One-liner**: unit tests always; core/complex logic thoroughly. No global coverage gate. E2E deferred.
**CTO note**: Jest for `apps/api`; `bun test` for `packages/shared`. E2E choice deferred (no critical flows yet).

---

**ADR-0017** — *Location type as a hardcoded enum*
**Status**: accepted
**One-liner**: `LocationType` is a Postgres enum (OFFICE, DATACENTER, RACK, REMOTE, STORAGE, OTHER); user-managed types deferred.
**CTO note**: don't add user-managed location types without a new ADR.

---

**ADR-0019** — *AssetAssignment referential integrity & lifecycle*
**Status**: accepted (actor source superseded by ADR-0024)
**One-liner**: assignment FKs use Restrict (history preserved); partial unique index `(assetId, userId) WHERE releasedAt IS NULL` in raw SQL migration.
**CTO note**: the actor source was superseded by ADR-0024; the lifecycle/integrity rules remain.

---

**ADR-0021** — *Knowledge Base design — simple wiki*
**Status**: accepted → **deepened by ADR-0042** (versioning + linking)
**One-liner**: Article + ArticleCategory; markdown body; DRAFT/PUBLISHED status; `.docx` import via mammoth.
**CTO note**: the old "ArticleVersion exists in schema but not wired" claim was **wrong** — it did not exist. **ADR-0042 is what actually creates it** (append-only ArticleVersion + ArticleLink); schema and docs now agree. Versioning is no longer deferred.

---

**ADR-0042** — *Knowledge Base depth — append-only versioning + asset/application linking*
**Status**: accepted (2026-06-01); deepens ADR-0021
**One-liner**: append-only `ArticleVersion` (snapshot on every versioned-field edit, autoincrement id, `@@unique([articleId, version])`) + `ArticleLink` join (article↔asset OR application, DB CHECK = exactly one target, two partial unique indexes) + article **content** now indexed in search.
**CTO note**: this CORRECTS the long-standing doc drift (ArticleVersion did NOT exist before; this ADR creates it). Snapshot written in the same `$transaction` as the article write. Reads paginated + draft-privacy-gated. **Linking UI shipped in the UX cycle (#111)**: reverse endpoints `GET /assets/:id/articles` + `GET /applications/:id/articles` (#104) feed a "Related articles" panel on asset/application detail and a "Linked to" panel on the article. Still no rollback-to-version and no version-history UI (later wave). Linking is asset/app only.

---

**ADR-0033** — *AssetHistory event model (discrete events, explicit emission)*
**Status**: accepted
**One-liner**: explicit service calls emit AssetHistory events transactionally (not an interceptor).
**CTO note**: event types: CREATED, STATUS_CHANGED, ASSIGNED, RELEASED, LOCATION_CHANGED, MODEL_CHANGED, SPECS_CHANGED, DELETED, RESTORED. RESTORED not yet emitted.

---

**ADR-0034** — *Consumables design (cached stock + append-only movements)*
**Status**: accepted
**One-liner**: `Consumable.currentStock` is a cached int updated transactionally by ConsumableMovement. Never edited directly.
**CTO note**: movement types: IN, OUT (409 if stock goes negative), ADJUSTMENT (absolute recount).

---

**ADR-0036** — *Integer fields bounded to the Postgres int4 range in shared schemas*
**Status**: accepted
**One-liner**: all `Int` fields in shared zod schemas are bounded with `z.number().int().min(0).max(2_147_483_647)` to prevent int4 overflow (P2020 → 500).
**CTO note**: raised by bug where Swagger UI sent `Number.MAX_SAFE_INTEGER`, causing P2020. New int fields must follow this pattern.

---

### Identity & access

**ADR-0015** — *Deployment model — self-hosted for IT teams*
**Status**: accepted
**One-liner**: Docker Compose as the deployment unit; single-org; customer's infrastructure; no cloud dependency.
**CTO note**: any feature requiring a managed cloud service violates this. Even the IdP must be self-hostable.

---

**ADR-0016** — *Authentication deferred; external IdP when needed*
**Status**: accepted → **fully superseded by ADR-0037/0038/0039/0040/0043** (auth epic delivered + live 2026-06-01)
**One-liner**: no auth yet; endpoints are unauthenticated; future auth = OIDC with self-hosted IdP; `User.externalId` reserved for `sub`.
**CTO note**: fully resolved. AuthN (JwtAuthGuard, OIDC + JIT + account-linking) + AuthZ (RBAC, DB-first) + frontend (Auth.js) + Zitadel source-of-truth/write-back all delivered.

---

**ADR-0022** — *Draft visibility & the X-User-Id auth shim*
**Status**: accepted → **superseded in the OIDC path by ADR-0038** (2026-05-27). Preserved as `AUTH_MODE=shim` for dev/tests.
**One-liner**: `X-User-Id` header simulates the caller; present+valid → actor, absent → anonymous, invalid → 400.
**CTO note**: shim is now the guard's `AUTH_MODE=shim` branch. Authorization rules (draft privacy, author-only writes) still use `@CurrentUser()` — same logic, different source.

---

**ADR-0023** — *Access management design (Application + AccessGrant)*
**Status**: accepted
**One-liner**: append-only AccessGrant per user+app; no uniqueness constraint (multi-grant allowed); revokedAt closes grant; actor from @CurrentUser().
**CTO note**: `GET /access-grants` is the most sensitive list endpoint (exposes all user↔app grants). First to paginate when SEC-007 is addressed.

---

**ADR-0024** — *Retrofit AssetAssignment actor to the X-User-Id shim*
**Status**: accepted → **superseded in the OIDC path by ADR-0038** (2026-05-27). Shim path preserved via `AUTH_MODE=shim`.
**One-liner**: removed `assignedById`/`releasedById` from request body; actor now comes from ActorService (resolved User from @CurrentUser()).
**CTO note**: body-supplied-actor divergence between AssetAssignment and AccessGrant is resolved. Both use ActorService (now trivial: `user?.id`).

---

**ADR-0040** — *Minimal RBAC — ADMIN / MEMBER / VIEWER role on User*
**Status**: accepted (2026-06-01); default flipped MEMBER→VIEWER by ADR-0043 → **authZ MECHANISM superseded by ADR-0046** (the `@Roles`/`RolesGuard` machinery is retired; the per-domain authZ *philosophy* is kept)
**One-liner**: single `Role` enum on `User`; `@Roles()` + `RolesGuard` composed AFTER `JwtAuthGuard`; gate AccessGrant writes, Users administration and all destructive DELETEs to ADMIN; VIEWER read-only.
**CTO note**: closed the May review's #1 finding (authN-without-authZ). **AuthZ is DB-first** — never a token claim — and that survives into ADR-0046. The hardcoded role→capability mapping and `@Roles`/`RolesGuard` were **replaced** by the configurable permission catalog + `@RequirePermission`/`PermissionGuard` (ADR-0046); the 3 roles themselves remain FIXED. First-ever user ADMIN; last-admin (409) & no-self-role-change (403) guards + `set-role` script remain.

---

**ADR-0046** — *Roles & Permissions v2 — fixed roles, fully-configurable permissions*
**Status**: accepted (2026-06-03); **supersedes the authZ MECHANISM of ADR-0040** (keeps its DB-first, per-domain philosophy) and **extends ADR-0043**
**One-liner**: the **3 roles stay FIXED** (ADMIN/MEMBER/VIEWER) but each role's **permissions are fully configurable at runtime** — a **permission catalog-as-code** (33 entries) in `@lazyit/shared`, a `RolePermission` matrix table, and a single `@RequirePermission('<domain>:<verb>')` + `PermissionGuard` + `PermissionResolverService` primitive (`@Roles`/`RolesGuard` RETIRED).
**CTO note**: **AuthZ is DB-first** (INV-1) and ADMIN is **immutable + always-full** (INV-8). The matrix is seeded by `buildDefaultRolePermissions` (a **safe-default** seed) and edited via GET/PUT `/config/permissions` (`settings:manage`); the UI reads its effective set from GET `/config/my-permissions`. **Read-authorization is CLOSED here** — 41 read GETs are `<domain>:read`-annotated and the seed pre-tightens `accessGrant:read` + `user:read` to **ADMIN+MEMBER**; 63 write gates migrated. The matrix is fully configurable with **friction not blocks**: coarse verbs (`settings:manage`/`user:manage`/`accessGrant:grant`) and `:delete` CAN be granted to MEMBER/VIEWER, surfaced with a ⚠ (admin-initiated delegation, accepted, no server prohibition). UX is **role-first** (presets + capability toggles + fine-tune), NOT a permission grid. **Permissions are never synced to the IdP** (BYOI-safe — Zitadel mirrors identity + the 3 roles only). Per-resource/row ACLs still out of scope.

---

**ADR-0048** — *Service Accounts — non-human principals with native tokens + direct permission grants*
**Status**: accepted (2026-06-03); extends ADR-0046; **annotates ADR-0040 as mechanism-superseded**
**One-liner**: a **separate `ServiceAccount` model** authenticated by a **lazyit-native hashed token** `lzit_sa_<id>_<secret>` (NOT a Zitadel machine-user → BYOI-safe; NOT a User flag), with **direct** permission grants from the same catalog (`ServiceAccountPermission`) — never a Role, never ADMIN; fail-closed.
**CTO note**: a **SA-token branch in `JwtAuthGuard`** resolves a ServiceAccount *principal* (not a User); `PermissionResolverService` resolves its direct grants. Token secret is **revealed once** on create (one-time reveal in the UI). **Audit attribution** (INV-SA-1..4): the 6 append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement, ArticleVersion, PermissionAuditLog) gained a nullable `serviceAccountId` actor column alongside the human `actorId` + an **at-most-one-actor CHECK**. Two deliberate carve-outs: the **ServiceAccountAuditLog's own SA-actor column** is deferred to a future ADR (SA-on-SA management → `null` for now), and **SA-authored Articles are rejected by design** (KB authorship stays human). `@CurrentPrincipal()` does the human→`actorId` / SA→`serviceAccountId` split.

---

**ADR-0043** — *Zitadel as the identity & authorization source of truth (Option B)*
**Status**: accepted (2026-06-01) — the headline auth-epic decision; **extends** ADR-0037/0038/0040; **validated live end-to-end 2026-06-01**
**One-liner**: Zitadel = source of truth for identity+roles+tokens; lazyit can WRITE BACK to the Zitadel Management API; an in-app `/setup` wizard (one build, one run); DEFAULT VIEWER; DB-first authorization; BYOI degrades gracefully via an `IdentityProvider` adapter.
**CTO note**: CEO approved all 7 forks with the recommended resolutions. The 7 guardrails are codified in `docs/06-security/INVARIANTS.md` (INV-1..7). Key shape: `IdentityProvider` interface (`auth/identity/`) + `GenericOidcIdentityProvider` (no-op management) + `ZitadelIdentityProvider`/`ZitadelManagementService` (Private-Key JWT SA; user-grants on v1 `/management/v1/users/...`, users on v2); write-back wired into ADMIN-gated Users (failure → 503, no split-brain; offboard deactivates inside the tx); zero-touch `zitadel-bootstrap` + `zitadel-secrets-init` sidecars + `zitadel_secrets` volume; idempotent CSRF+rate-limited `POST /config/setup`. **Authorization stays DB-first — a token role claim is NEVER an authZ source.** No bulk role-sync built (dev-only; revisit before prod).

---

### Cross-cutting concerns

**ADR-0029** — *Untrusted-content sanitization is render-time, not write-time*
**Status**: accepted
**One-liner**: store raw, sanitize at render time with allow-list (DOMPurify). Write-side only for clearly-dangerous structured values (e.g. URL schemes).
**CTO note**: the regex import sanitizer was removed (commit `8e34074`). SEC-003 stays open until DOMPurify lands in the web KB renderer.

---

**ADR-0030** — *List endpoint pagination contract (offset) + sort/filter/archived amendments*
**Status**: accepted; **amendment §6 (sort/`dir`) + §7 (`deleted=active|only`) — 2026-06-01**
**One-liner**: `PageQuery` + `Page<T>` in `@lazyit/shared`; default 50, max 200. Amendment §6 added `sort` + `dir` (per-resource ALLOWLIST, unknown→400); §7 added `deleted` (`active`|`only`, ADMIN-only for `only`, invalid→400) over the ADR-0032 `includeSoftDeleted` hatch.
**CTO note**: contract is now fully implemented — `Page<T>` + server `q`/sort/`dir`/`deleted` live on all 6 main lists + /articles + /access-grants + /dashboard/activity (#104/#114). New list endpoints must use it. ADMIN batch endpoints (`POST /assets/batch/{delete,restore,status}` + `POST /access-grants/batch/revoke`, body `{ids}` → `{requested,succeeded,skipped}`) landed alongside (#104). Cross-linked from ADR-0041 (restore).

---

**ADR-0031** — *Structured logging strategy (Pino + nestjs-pino)*
**Status**: accepted
**One-liner**: Pino + nestjs-pino; JSON in prod, pretty in dev; X-Request-Id per request; bodies NOT logged.
**CTO note**: `X-Request-Id` is exposed via CORS and surfaced in the frontend error UX.

---

**ADR-0032** — *Soft-delete enforcement via a Prisma client extension*
**Status**: accepted; reuse/restore added by ADR-0041
**One-liner**: `$extends` on PrismaService automatically adds `deletedAt: null` to read queries.
**CTO note**: append-only tables are excluded. Services never need to remember to add `deletedAt: null`. `includeSoftDeleted` escape hatch added for restore (ADR-0041).

---

**ADR-0041** — *Soft-delete reuse — partial unique indexes, restore, citext email*
**Status**: accepted (2026-06-01); builds on ADR-0006/0032/0033, reuses ADR-0040's RolesGuard
**One-liner**: every `@unique` on a soft-deletable model becomes a PARTIAL unique index `WHERE "deletedAt" IS NULL` (raw SQL) to free email/slug/sku/name/serial/assetTag; ADMIN-gated `POST /<resource>/:id/restore`; `User.email` becomes `citext`.
**CTO note**: closes the "value burned forever by a ghost row" + duplicate-user-by-email classes. `User.externalId` deliberately stays a FULL unique (the JIT upsert/link needs it). Asset restore finally emits the reserved `RESTORED` event; Article restore is author-only; User restore does NOT re-grant/re-assign. Restore can legitimately 409. No bulk/cascade restore.

---

**ADR-0044** — *Dashboard recent-activity feed backed by a unified DB view*
**Status**: accepted (2026-06-01); builds on ADR-0030 + ADR-0032
**One-liner**: a Postgres VIEW `recent_activity` `UNION ALL`s asset_history + asset_assignments + access_grants + consumable_movements into one normalized, newest-first, paginable stream; read via typed `$queryRaw` at `GET /dashboard/activity`.
**CTO note**: the view is raw SQL in a migration (Prisma can't express a UNION view — same pattern as the partial indexes) and **re-derives soft-delete filtering in SQL** (the `$extends` extension doesn't touch raw SQL — a documented duplication). New activity sources extend it by adding a `UNION ALL` branch. The old AssetHistory-only `DashboardSummary.recentActivity` is now redundant (kept for back-compat).

---

### Workflow & coordination

**ADR-0013** — *Custom ZodValidationPipe*
**Status**: superseded by ADR-0018
**CTO note**: ignore this ADR; ADR-0018 (nestjs-zod global pipe) is the current pattern.

---

## Index continued — ADRs 0049–0081

> Added 2026-07-01. These extend the thematic index above but are listed **chronologically by number** (easier to verify against `docs/03-decisions/` and to scan by ADR id). Status in each line reflects the file's frontmatter. **Numbering caution:** the "Decisions made outside ADRs" table below still calls the 2026-06-06/-07 Settings-&-Notifications work "ADR-0052" — that predates renumbering. In the accepted tree **ADR-0052 is the CI-docker-parallelization ADR**; that early notifications/SMTP work actually landed as the **notification bell (ADR-0056)** + **instance SMTP (ADR-0079, proposed)**. Treat the old "ADR-0052 settings/notifications" references as stale labels, not the current ADR-0052.

**ADR-0049** — *«Activated Restraint» — design-system activation direction*
**Status**: accepted
**One-liner**: adds an *expression layer* over the ADR-0011 tokens — a reduced-motion-safe motion vocabulary, an elevation language, and activation of the dormant categorical/semantic hues — all via `globals.css` tokens + composition (no `components/ui/*` hand-edits, no new runtime deps).
**CTO note**: closes the CEO's "no onda / half-built UI" gap by *activation + craft*, not by brightening the dial. Its palette is later **re-tuned onto the Ledger neutrals** by ADR-0077.

---

**ADR-0050** — *UserHistory append-only log + a `user` entity in recent-activity*
**Status**: accepted
**One-liner**: adds `UserHistory` (table `user_history`, a 1:1 structural copy of `asset_history`) — append-only, same nullable-actor pair + at-most-one-actor CHECK as the ADR-0048 audit tables — and surfaces a `user` source in the ADR-0044 `recent_activity` view. Events: `CREATED, UPDATED, ROLE_CHANGED, DELETED, RESTORED, PASSWORD_RESET_SENT`.
**CTO note**: mirrors ADR-0033/0048 exactly; new user-mutation paths must emit `UserHistory` transactionally.

---

**ADR-0051** — *i18n with next-intl (cookie-mode, en + es)*
**Status**: accepted
**One-liner**: next-intl 4.x in **cookie-mode** for `apps/web`; **English default+fallback, Spanish second**; active locale in the `NEXT_LOCALE` cookie — no URL prefix, no route restructure.
**CTO note**: every user-facing string is now bilingual. i18n-key-path errors are a class **CI cannot catch** — en/es parity is a review gate. This is *why* the Manual + every web change ship en+es.

---

**ADR-0052** — *Parallelize CI Docker builds (matrix) + decouple from verify*
**Status**: accepted
**One-liner**: CI `docker` becomes a `matrix` job over `[api, web, migrate]` (`fail-fast:false`) that **no longer `needs: verify`** (build + quality gate run in parallel); `verify` persists the Turborepo cache.
**CTO note**: CI-only change. NOTE the numbering caution above — this is the *real* ADR-0052.

---

**ADR-0053** — *Async workers — BullMQ on Valkey, sandboxed processors*
**Status**: accepted
**One-liner**: adopts **BullMQ on a self-hosted Valkey** via `@nestjs/bullmq` (ioredis), **app-layer only** (ADR-0009 carve-out); Valkey is a new backing service (unprofiled for dev + `prod` profile, AOF persistence); untrusted/memory-heavy jobs run in **sandboxed child processors**.
**CTO note**: **resolves the long-parked "async workers deferred" open question.** Unblocks SEC-002 (docx bomb), the workflow engine, and email dispatch. Worker co-located in the `api` container for now; `REDIS_URL` from env.

---

**ADR-0054** — *Applications Workflow Engine — data model & engine foundations*
**Status**: accepted
**One-liner**: an **opt-in extension of the Access pillar** — BullMQ-on-Valkey as transport, **PostgreSQL as the durable system of record**; the engine fires from a domain event emitted **AFTER the `AccessGrant` tx commits — never inside it** (the inverse of INV-5).
**CTO note**: a failing external provisioning call **never** rolls back / blocks / 503s the grant — the grant is the durable audit fact; an un-provisioned account is a recoverable `FAILED` run + notification, not a split-brain. Phase-1a lands entities/enums/`@lazyit/shared` contracts. Entities: ApplicationWorkflow, WorkflowVersion, WorkflowRun, WorkflowStepRun, WorkflowConnection, WorkflowSecret, ManualTask.

---

**ADR-0055** — *On-prem / internal-target connectors — a per-connection audited allowlist*
**Status**: **proposed**
**One-liner**: an ADMIN-gated, per-`WorkflowConnection` **audited allowlist** wired to the `isInternalTargetAllowed` seam; the IP classifier (`common/egress/ip-rules.ts`) is the **un-allowlistable hard floor** — loopback/IMDS/link-local/CGNAT/reserved are denied *before* the allowlist is consulted; the allowlist can only widen reach within RFC1918/ULA.
**CTO note**: **PROPOSED, not accepted** — the gate before workflow connectors may target internal hosts. Protects the engine's co-located secrets (Valkey/Postgres/Zitadel) + cloud IMDS unconditionally.

---

**ADR-0056** — *In-app notification bell — append-only Notification + per-admin read state (admin-only, v1)*
**Status**: accepted
**One-liner**: an append-only `Notification` + per-admin `NotificationRead` join (fan-out-on-read); **ADMIN-only v1**; poll delivery; a closed shared `type` enum; redacted metadata only (names/ids, never bodies/secrets — INV-6); deep-link `entityType`/`entityId`; `dedupeKey`.
**CTO note**: this is the ADR that *actually numbers* the notification-bell work (the old outside-ADR "ADR-0052 notifications" reference is stale — see numbering caution).

---

**ADR-0057** — *Retry-after-fix vs pinned-version replay*
**Status**: accepted
**One-liner**: ships **both** clone-to-new-run from the latest version (Option 3, primary/invariant-clean) **and** a transient payload-override break-glass on retry (Option 2, INV-6-safe); idempotency via a **sequence-suffix** key `<trigger>:<accessGrantId>:<n>`; double-provision **fails closed** unless every step up to the failure is `idempotent:true`.
**CTO note**: workflow-engine follow-on to ADR-0054; a `supersedesRunId` records run lineage. In-place re-pin (Option 1) stays rejected.

---

**ADR-0058** — *User identity graph (legajo / username / manager) + clone-with-actions*
**Status**: accepted
**One-liner**: adds optional `User` fields `legajo`, `username` (each **live-only partial-unique** — soft-delete frees them, like `email`) and `managerId` (self-FK, SetNull) **XOR** `managerName` (free-text) enforced by a DB CHECK; plus a **clone-user-with-chosen-actions** flow.
**CTO note**: **`username` is NOT an auth credential** and **never** an account-linking key — the linking key stays `email`/`externalId` (INV-2); `username` is a directory/display field only.

---

**ADR-0059** — *Knowledge Base v2 — folders, aliases, wiki-links & bulk import*
**Status**: accepted
**One-liner**: evolves the flat `ArticleCategory` into a hierarchical **Folder** (self-ref `parentId`); every article keeps **exactly one required home folder**; adds **aliases** + **wiki-links** navigation primitives + a **bulk-import** worker.
**CTO note**: the home folder is the single governing folder read by ADR-0060's access control. Deepens ADR-0021/0042. New entities: ArticleAlias, ArticleWikiLink.

---

**ADR-0060** — *Knowledge Base access control — folders as the permission boundary*
**Status**: accepted
**One-liner**: access attaches to a **Folder**; an article **inherits** its home folder's rule; **no per-article ACL**. A **new orthogonal data-scoping axis** layered on the role→permission catalog — `article:read` gates whether you can act on the KB *at all*; the **folder ACL** gates **which** articles you see.
**CTO note**: **INV-9.** v1 is evaluated on the article's home-folder rule with restriction inherited *down* the tree.

---

**ADR-0061** — *Secret Manager — zero-knowledge vaults beside the Knowledge Base*
**Status**: accepted
**One-liner**: a **third, deliberately divergent secret store** — **envelope crypto** (random per-vault DEK + per-user asymmetric keypair); the server can **NEVER read the value** (zero-knowledge); **server / DB-dump / ADMIN / subpoena are IN scope** of the threat model; recovery via a recovery key or peer re-wrap, else **permanent loss**.
**CTO note**: **INV-10 = the server never decrypts.** Entities: SecretVault, SecretItem, UserKeypair, VaultMembership, SecretAuditLog (+ ServiceAccountKeypair / ServiceAccountVaultMembership via ADR-0080). The load-bearing inversion vs `WorkflowSecret` (ADR-0054, server-decryptable **by design**) and the SA token (ADR-0048, one-way hash). Before building near it: **there is NO `Secret` model** — the entities are `SecretItem` / `SecretVault`.

---

**ADR-0062** — *In-app Help / Manual surface — shipped product documentation, distinct from the KB*
**Status**: accepted
**One-liner**: a fixed, **shipped-with-the-code** product-documentation surface — markdown files in the repo, rendered by the markdown view, **PUBLIC / login-free**, in the Next.js `(marketing)` route group; distinct from the KB (**product-authored** vs operator-authored, code-versioned vs DB rows).
**CTO note**: the **STANDING Manual-sync rule** (CLAUDE.md #7) — every user-facing change updates its Manual page **en+es** in the same change. Amended 2026-06-16 to live on the public landing side.

---

**ADR-0063** — *Configurable Asset Tag Scheme — instance config + monotonic counter, OFF by default*
**Status**: accepted
**One-liner**: lazyit's **first instance-config entity** — a **single-row `AssetTagScheme`** (template with a mandatory `{num}` token + optional prefix/suffix + zero-pad width) + a **global monotonic counter** allocated in-tx with retry; **OFF by default**.
**CTO note**: one org-wide sequence (not per-prefix/category in v1); **gaps accepted**. Extended by ADR-0068 (existing-estate awareness).

---

**ADR-0064** — *Admin user provisioning credentials — temporary password only, forced change at first login*
**Status**: accepted
**One-liner**: a **full-page, asset-style** user-creation flow with **optional** assign-asset / grant-app at create time; credential provisioning is a **bounded carve-out** — **temporary password only, `changeRequired=true`, email auto-verified, HIDDEN under BYOI**, gated by the existing `user:manage`.
**CTO note**: reuses existing assignment/grant write paths + authz (a UX convenience, not a new authz surface); the temp-password path exists only when the bundled IdP owns identity.

---

**ADR-0065** — *Secret Manager — regenerate the recovery key for an existing keypair*
**Status**: **superseded** (by ADR-0066, 2026-06-15)
**One-liner**: would let a user who can still unlock with their **passphrase** mint a new recovery key + re-wrap the **existing** private key (a recovery-wrap re-mint — keypair unchanged, memberships intact).
**CTO note**: **superseded same-cycle by ADR-0066**, which made the recovery key a **fixed root** (rotation deferred). Do NOT implement 0065.

---

**ADR-0066** — *Secret Manager — password is the daily entry credential, recovery key is the root that resets it*
**Status**: accepted (supersedes ADR-0065)
**One-liner**: the two credentials are **asymmetric** — the **password** is the daily **ENTRY** credential (mutable, direct-unlock); the **recovery key** is the **ROOT / DR** artifact (fixed at bootstrap, shown once, **not** a direct entry path). The root can reset the password; the password can never touch the root.
**CTO note**: reverts ADR-0065's recovery-key rotation. Decisive rule: the weaker credential can never replace the root.

---

**ADR-0067** — *Server-prefetch + hydration rendering strategy for high-traffic routes*
**Status**: accepted
**One-liner**: **Option C** — targeted server-prefetch on **6 high-traffic routes** (`/dashboard`, `/assets`, `/applications`, `/consumables`, `/users`, `/locations`) that become thin Server Components prefetching their primary list query before sending HTML.
**CTO note**: a scoped pilot, **not** app-wide SSR; first-paint paths only.

---

**ADR-0068** — *Asset Tag Scheme — existing-estate awareness (skip-existing invariant + backfill with preview)*
**Status**: accepted (extends ADR-0063)
**One-liner**: **an auto-allocated tag is NEVER one already on a LIVE asset** (skip-on-exists, by construction + defended by the live-only partial-unique index `assets_assetTag_active_key`); adds **backfill with preview**; the old `MAX_ALLOCATION_ATTEMPTS` cap survives only as an infinite-loop sanity bound.
**CTO note**: monotonic-with-gaps; must **never** surface a false 409 in a dense-occupancy estate.

---

**ADR-0069** — *Migrator — guided bulk import (phase 1: Asset slice, JSON + CSV)*
**Status**: accepted
**One-liner**: **phase 1 imports exactly `Asset`** from JSON/CSV, building the full machinery (parse/coerce, reference resolution, interactive conflict menu, stateful wizard, per-row commit) on the pure-DB asset path; **dry-run → persisted plan → replay-at-commit**, no human in the loop mid-commit.
**CTO note**: async sandboxed parse (`import:run`); architecture proven on the simplest slice before phase 2 layers on more entities. Entities: ImportSession, ImportRun, ImportRow.

---

**ADR-0070** — *Infra topology graph — a generic visual CMDB of the server estate (InfraNode + InfraEdge)*
**Status**: accepted
**One-liner**: a **generic topology graph** — `InfraNode` (the things) + `InfraEdge` (typed, timestamped relationships) — on a free-move canvas; a node is **Asset-backed by default** (inherits owner/KB/secrets/warranty/shortcuts) and can be **detached** to a graph-only node for ephemerals.
**CTO note**: a **new pillar**. Rejected: overloading `AssetCategory` / a `Server` 1:1 table / platform-specific node kinds. §7 impact (blast-radius) walks `RUNS_ON`/`DEPENDS_ON` + (amended) `MEMBER_OF` (#802). Extended by ADR-0073 (node→secret) + ADR-0074 (agent-reported nodes).

---

**ADR-0071** — *KB write-mode syntax highlighting — overlay over the textarea*
**Status**: **superseded** (reverted 2026-06-24, issue #803)
**One-liner**: a highlighted `<pre>` layer **behind** the ADR-0021 `<textarea>` (transparent text, visible caret, shared typographic box, `react-syntax-highlighter`); the `[[`/`{{` autocompletes unchanged.
**CTO note**: **REVERTED** — the overlay kept drifting caret↔glyph even after the color-only fix; removed (`markdown-source-highlight.tsx`/`-theme.ts` deleted, textarea back to plain visible text) while **keeping** the autocompletes + caret-aware popups. Do NOT reintroduce the overlay. (ADR-0021 always intact.)

---

**ADR-0072** — *Quick View — entity-preview popover in pickers & search*
**Status**: accepted
**One-liner**: an entity-preview popover built on the **vendored radix `Popover`** (NOT HoverCard/Tooltip) — controlled `open`+`pinned`, hover-preview + **click/Enter/Space-to-pin**, reusing `DetailField`/status badges; keyboard-open via an **Alt+Enter** chord on the cmdk root.
**CTO note**: data reused **in-memory** (zero fetch); applied to combobox / entity-multi-select / global search.

---

**ADR-0073** — *Infra node → secret linkage (soft handle-refs, member-scoped attach)*
**Status**: accepted
**One-liner**: `InfraNodeSecretRef {nodeId, vaultId, handle}` — a **real FK to `InfraNode`** (Cascade) but **NO FK to `SecretItem`** (soft metadata, mirroring KB chips + `SecretAuditLog`); resolved at read against live secrets, dangling refs **dropped**; `handle`/`vaultId` are **metadata only, never a value** (INV-10).
**CTO note**: **attach is member-scoped** — asserts a live `VaultMembership` (checked **first**, so no existence leak); discrete `POST`/`DELETE /infra/nodes/:id/secrets`, not whole-array replacement.

---

**ADR-0074** — *Server reporting agent — self-installing Linux collector that auto-reports inventory*
**Status**: accepted
**One-liner**: a **self-installing Linux** (x64/arm64) agent that auto-reports **INVENTORY ONLY** (host identity / hardware / installed software) for **SELF only**; new hosts arrive **`PENDING`, `source=AGENT`** in a **review tray** (a human confirms); **one shared `AgentReportSchema`** in `@lazyit/shared` imported by both the agent binary and the API (`POST /infra/report`).
**CTO note**: lives in **`apps/agent`** (`collect.ts`/`config.ts`/`index.ts`); reports land as `InfraNode` rows (ADR-0070) with liveness via the staleness sweeper. Rejected health/metrics, network scanning, auto-confirm; OS-neutral contract so Windows/macOS can be added later. `apps/api/src/agent-dist` serves the installer/binary.

---

**ADR-0075** — *Typed secrets via client-side structured payload + server-visible `kind` metadata*
**Status**: accepted
**One-liner**: a "typed secret" is a **client-side JSON encoding inside the SAME opaque ciphertext** (no crypto-path change, no new value column, **no server-side payload validation**); the only server-visible addition is a `SecretItem.kind` enum (`GENERIC` default / `SSH_KEY` / `TOTP` / `CERTIFICATE`) — **metadata only**, telling the UI which form/renderer to use **without decrypting**.
**CTO note**: preserves INV-10; `kind` never describes the plaintext, only how the client encodes/renders it.

---

**ADR-0076** — *Optional Company grouping field on assets (not a tenancy boundary)*
**Status**: accepted
**One-liner**: an **optional free-text `Asset.company`** column (mutable-domain, rides the asset's soft-delete) — a **GROUPING** attribute, **NOT** a tenancy/access boundary; free-text + `<datalist>` autocomplete from used values (`GET /assets/companies`); **Modo B (per-record scoping) REJECTED (#841)**.
**CTO note**: **no RBAC change** — anyone with `asset:read` sees every asset; company only **narrows a list you could already see**. No Company entity/table/CRUD.

---

**ADR-0077** — *«The Ledger» — adopt the landing's design language in the app*
**Status**: accepted
**One-liner**: adopt **The Ledger** as the app's design language via a **layered, tokens-first migration** (never big-bang) — **oxblood becomes THE lazyit brand color, replacing indigo** across app + landing + docs + logo; swap token **values** (names stay) to the Ledger palette + Hanken/Commit Mono; Ledger-native patterns (status→**stamp**, audit→**ledger tape**) applied selectively where the data IS a record.
**CTO note**: supersedes the indigo era (ADR-0011/0049 palette) **in spirit**; re-tunes the pillar/chart data palette onto the new neutrals. Big frontend refactor (branch `refac/frontend-design`).

---

**ADR-0078** — *Advisory per-category specs dictionary (extends ADR-0007)*
**Status**: accepted
**One-liner**: an `AssetCategory` MAY declare a declarative **`specsSchema Json?`** (a small field list `{key,label,type,required?,enumValues?}`, **NOT** executable zod / a JSON-Schema engine) that is **ADVISORY** — produces soft warnings + UI hints, **never a 400**; extra keys allowed (just flagged).
**CTO note**: extends ADR-0007 — `Asset.specs` stays an **open** jsonb; `null` dictionary = no governance (default). Pure helper `validateSpecsAgainstDictionary` in `@lazyit/shared`.

---

**ADR-0079** — *Instance SMTP + outbound email for notifications*
**Status**: **proposed**
**One-liner**: a **singleton `SmtpSettings`** instance-config store (mirrors `AssetTagScheme`, `id='singleton'`) + a **BullMQ email-dispatch worker** wired as a channel behind `emit()`; the SMTP password is **AES-256-GCM at rest, write-only, on its own key axis**; `GET`/`PUT /config/smtp` + `POST /config/smtp/test`, gated `settings:manage` + `ServicePrincipalForbiddenGuard`.
**CTO note**: frontmatter says **proposed** (2026-06-30) — **verify accepted before treating as final**, though the `apps/api/src/smtp` module exists in the tree. This is the ADR that *actually numbers* instance SMTP (the old "ADR-0052 SMTP" reference is stale). Builds on ADR-0053 (workers) + ADR-0056 (notifications).

---

**ADR-0080** — *Programmatic secret retrieval via a service account (headless, client-side decrypt)*
**Status**: accepted
**One-liner**: a **service account becomes another keypair holder** in the ADR-0061 envelope — a client-generated **X25519 keypair per SA**, private key wrapped **once** under an **Argon2id** KEK derived from the **SA token secret** (the SA token plays the human passphrase's role — **no crypto-invariant change**); the server stores only the SA public key + wrapped private key + the token SHA-256 hash.
**CTO note**: headless client-side decrypt via **`packages/fetch-cli`**. A keypair is now minted for **every** SA (#883 dropped the earlier `secret:fetch`-only gate — a keyless SA was a footgun). **INV-10 preserved.** Entities: ServiceAccountKeypair, ServiceAccountVaultMembership.

---

**ADR-0081** — *In-app read + CSV export for the security audit logs*
**Status**: accepted
**One-liner**: a thin **reader-only** module `apps/api/src/audit/` (`AuditModule`/`Controller`/`Service` — readers live HERE, writers stay in their own modules) exposing `GET /audit/logs` (paged/filtered read of ONE source: `secret` | `permission` | `serviceAccount`, newest first), `GET /audit/logs/export` (**streamed CSV**, `StreamableFile`, never buffers), and `GET /audit/logs/filters`; all `@RequirePermission('logs:read')`.
**CTO note**: surfaces the existing append-only audit ledgers for reading; a new `logs:read` capability; reuses the ADR-0044 / #840 CSV-export mold. Web surface at `/reports/audit`.

---

## Decisions made outside ADRs

| Date | Decision | Context | Implication |
|------|----------|---------|-------------|
| 2026-05-25 | SEC-002 deferred to BullMQ async worker | .docx decompression bomb requires memory-budgeted worker | Must not build BullMQ without addressing SEC-002 in the same work |
| 2026-05-25 | SEC-003: store raw KB content, sanitize at render time (ADR-0029) | DOMPurify at the frontend KB renderer | Don't add a raw-HTML renderer without DOMPurify in the same change |
| 2026-05-25 | SEC-007: pagination contract defined (ADR-0030), implementation deferred to subagent split | MVP scale tolerable for now | Two subagents (back + front) when impl starts; GET /access-grants first |
| 2026-05-26 | Frontend completion epic (#20) fully closed | All 5 sub-issues merged | Frontend now matches backend capability |
| 2026-05-26 | **Zitadel chosen as bundled IdP** | Fits operator profile (IT generalist + Docker); lighter than Keycloak; simpler stack than Authentik | All auth epic design is Zitadel-first; BYOI must remain possible via env swap |
| 2026-05-26 | **Zitadel gets its own Postgres** (not shared with app DB) | Clean separation; Zitadel does aggressive migrations; independent backup; clean BYOI removal path | Two DB services in prod compose; DevOps owns the Zitadel DB service |
| 2026-05-26 | **BYOI is load-bearing** — backend must speak standard OIDC, not Zitadel-specific | Customer may bring Azure AD, Okta, Keycloak; swap IdP by editing .env only | Must be documented in auth ADR; no Zitadel SDK in app code |
| 2026-05-26 | **Bootstrap runbook for first admin** is Phase 1 deliverable | Operator won't know Zitadel console; DevOps must provide a clear runbook | No skipping this; a self-hosted product is unusable if the first user can't be created |
| 2026-05-26 | **Frontend auth library**: Auth.js v5 (NextAuth) with generic OIDC provider — CTO's call | BYOI-compatible (generic OIDC provider config); App Router native; HTTP-only cookie session | Documented as **ADR-0039** (accepted) |
| 2026-05-26 | **X-User-Id shim retained** as `AUTH_MODE=shim` env var (dev/test only) | Existing Jest tests use it; rewriting adds no value; must be impossible to set in prod by default | Disabled in prod by default; guards must verify env before accepting shim |
| 2026-05-26 | **Phase 2+4 merged** — ActorService → @CurrentUser() is part of backend OIDC integration, not a cleanup phase | CEO's guidance: changing the actor source is integral to the integration, not a post-step | Backend agent delivers ActorService migration in the same phase as JWT validation |
| 2026-05-26 | **JIT user provisioning: auto-provision on first login (Option 1)** | For 5–20 users with a trusted IdP, admin controls who enters in Zitadel; extra lazyit step is friction | ADR-0038 must document: assumes trusted IdP; if a customer wants stricter policy, Option 3 (pending activation) added as an optional mode later |
| 2026-06-01 | **Auth = Option B: Zitadel is the identity & authorization SOURCE OF TRUTH** (write-back + in-app wizard + DEFAULT VIEWER) | CEO approved all 7 forks with the recommended resolutions; moves lazyit "from a functional tool to a product" | Recorded as ADR-0043; the 7 guardrails are codified in `docs/06-security/INVARIANTS.md` |
| 2026-06-01 | **Authorization is DB-first; a token role claim is NEVER an authZ source** | A forged/misconfigured token must not escalate; keeps authZ vendor-neutral + BYOI-safe | RolesGuard always re-reads `User.role` from the DB (INV-1); the token-authoritative variant was explicitly rejected |
| 2026-06-01 | **DEFAULT role = VIEWER, uniform** (app-created AND non-first JIT) | Least privilege by default; new identities start read-only and are explicitly promoted | First-ever user on an empty DB STILL ADMIN; existing rows keep their role (no bulk sync) |
| 2026-06-01 | **Soft-delete restore policy: restore + partial unique indexes + citext email** | Soft delete was a one-way door that burned values forever; OIDC made case-sensitive email a duplicate-user trap | ADR-0041; restore endpoints ADMIN-gated; `User.externalId` deliberately stays a FULL unique |
| 2026-06-01 | **Scheduler / async workers still DEFERRED** | No recurring job is actually needed yet; BullMQ+Redis not chosen | Don't build cron/queue work (expiry reminders, periodic role-sync) without an ADR |
| 2026-06-01 | **No existing-user → Zitadel bulk role-sync built** | lazyit runs only on `dev`; operator uses `docker compose down -v` for a clean slate | ADR-0043 Fork #6; **revisit before any production deployment** |
| 2026-06-01 | **UX/UI overhaul run as a 21-agent read-only audit → implemented in dependency waves** | The web lagged backend capability; a parallel audit surfaced the gaps, then work shipped as ordered waves (#100–#115) so contracts landed before consumers | Confirms the "fan-out read-only audit, then serialize the build by dependency" pattern; tokens/primitives before pages, backend list contract (#104) before the list chain (#110) |
| 2026-06-01 | **Approved Fase 1+2 + four NEW surfaces** (settings admin area · KB runbooks UI · soft-delete restore UI · bulk actions) | Beyond polish, the cycle added net-new operator capability that the backend already supported (restore endpoints, ArticleLink, batch) | Delivered as #108 (settings), #111 (runbooks), #112 (restore + bulk); access-grants bulk-revoke data layer shipped but UI deferred (no owned grants table) |
| 2026-06-01 | **Chose heroicons over the brief's lucide** (least churn) | The audit brief proposed lucide; the app already leaned heroicons, so standardizing on heroicons minimized rework | Recorded as **ADR-0045** (accepted); lucide dropped entirely; two-weight convention |
| 2026-06-01 | **Approved the `Page<T>` sort/`dir` contract + migrating the 4 remaining lists server-side + `deleted=only` archived listing** | Real pagination/sort/search UI needs an authoritative server contract; archived listing needs an ADMIN-only escape hatch | ADR-0030 amendment §6 (sort/`dir`, per-resource allowlist, unknown→400) + §7 (`deleted=active\|only`); applications/consumables/users/locations migrated onto `Page<T>` + server `q` (#104/#114); fixed a consumable soft-delete leak |
| 2026-06-01 | **Authorized the CTO to merge the UX-cycle PRs to `dev`** (not `master`) | A large multi-wave cycle; the CEO delegated `dev` merges for this cycle while keeping `dev → master` promotion to themselves | Exception scoped to this cycle's PRs; the standard "agents never merge; CEO promotes to master" rule otherwise stands |
| 2026-06-03 | **RBAC v2: keep 3 FIXED roles, make permissions fully configurable** (not a free-form role system, not a per-resource ACL matrix) | Configurability where operators need it (capabilities), stability where they don't (the role set); avoids the complexity of arbitrary roles/ACLs | ADR-0046; catalog-as-code in `@lazyit/shared`, `RolePermission` table, `@RequirePermission`; ADMIN immutable/full (INV-8) |
| 2026-06-03 | **Read-authorization CLOSED via a safe-default seed** (`accessGrant:read` + `user:read` pre-tightened to ADMIN+MEMBER) | The headline Medium debt; closed without a blocking redesign — every read GET is `:read`-gated and the default seed scopes the two sensitive reads | Resolves the long-standing "all GETs open to any authenticated user" gap; VIEWER no longer reads grants/users by default |
| 2026-06-03 | **Fully-configurable matrix = friction, not blocks** — `:delete` + coarse verbs ARE grantable to MEMBER/VIEWER (⚠ in the UI) | Admin-initiated delegation is the operator's call; the product warns but does not forbid | No server-side prohibition; the ⚠ is the guardrail; role-first UX (presets + capabilities), not a grid |
| 2026-06-03 | **Service Accounts = a SEPARATE principal with a lazyit-native token** (NOT a Zitadel machine-user, NOT a User flag) | Keeps SAs BYOI-safe and decoupled from the IdP; SAs are a lazyit concept, not an identity-provider one | ADR-0048; `lzit_sa_<id>_<secret>` hashed token, SA-token branch in JwtAuthGuard, direct catalog grants (never Role/ADMIN), fail-closed |
| 2026-06-03 | **SA audit attribution via nullable `serviceAccountId` columns + at-most-one-actor CHECK** on the 6 append-only tables | A row must be attributable to a human XOR a SA (or neither); keeps the audit trail honest without overloading `actorId` | INV-SA-1..4; ServiceAccountAuditLog's OWN SA-actor column deferred to a future ADR; **SA-authored Articles rejected by design** |
| 2026-06-03 | **`start.sh` first-deploy bootstrap** (idempotent, non-destructive) | A self-hosted product needs a single obvious entry point for first deploy | ADR-0047; DevOps lane; pairs with the zero-touch sidecars + `/setup` wizard |
| 2026-06-03 | **SEC-009 (Swagger public in prod) + SEC-010 (XFF-spoof setup rate-limit) CLOSED** | Two findings remediated within the epic | Swagger no longer mounted under `NODE_ENV=production`; the `/config/setup` rate-limit no longer trusts a spoofable XFF header |
| 2026-06-03 | **`migrate.Dockerfile` hotfix committed DIRECTLY to `dev`** (`69fb9cf`) at the CEO's explicit request | The migrate image must build `@lazyit/shared` before the seed runs (the seed imports the permission catalog); an urgent fix, not a feature | A deliberate one-off exception to the branch+PR flow, authorized by the CEO |
| 2026-06-03 | **Epic run as: read-only design/audit workflow → CEO forks → serialized implementation waves, each gated by an adversarial multi-agent review** (correctness + sentinel, with verification) before merge | Re-applied and validated the "fan-out read-only audit, then serialize the build" pattern, now with an adversarial review gate per wave | Confirms the pattern for high-stakes (authZ) epics; no agent scope changed |
| 2026-06-06 | **ADR-0052 — Settings & Notifications backend** (settings store + encrypted secrets + user notification prefs + in-app bell + SSE + fail-soft email dispatch) | Resolved the long-parked "Settings backend (general app settings store)" open question; SMTP becomes app-managed (encrypted `SystemSecret`, redacted `SettingAuditLog`), notifications are opt-in by default, SSE is the v1 process-local realtime transport | Lives on branch `feat/settings_notifications_smtp` (~18 commits), **NOT yet on `dev`**. New modules: `SettingsModule`, `NotificationsModule`. New entities: SystemSetting, SystemSecret, SettingAuditLog, UserNotificationPreference, Notification, NotificationDelivery. Durable async queue + cross-process SSE fanout explicitly deferred to the pending workers ADR |
| 2026-06-07 | **SSE bell-feed auth = fetch-based Bearer client, backend unchanged** (NOT native `EventSource`, NOT cookie-on-route, NOT query-token) | Native `EventSource` can't send the `Authorization` header and our auth is Bearer/X-User-Id, DB-first (INV-1); a fetch-based SSE client (`@microsoft/fetch-event-source`) reuses the session-token store like the rest of the web API client (ADR-0039) | The web will consume `GET /notifications/stream` via a fetch-based SSE client; the backend SSE route stays `@RequirePermission()`-gated, no auth change. Documented in ADR-0052. Decided during the pre-frontend hardening pass of `feat/settings_notifications_smtp` (schema empty-string→400 fix, SSE heartbeat + teardown, exhaustive notification type maps, Caddy SSE no-buffering verified). Hardening dispatched via 2 parallel worktree subagents, merged LOCALLY by SHA (no push, CEO's request) |
| 2026-06-07 | **Settings/Notifications FRONTEND built — 3 surfaces + 2 IA decisions** | The ADR-0052 frontend: SMTP admin form (`/settings/smtp`, settings:manage), per-user notification preferences (`/account/notifications`, ungated, from the user-menu), and a topbar notification bell with live SSE. CEO decisions: (1) preferences live in a NEW `/account` area reached from the user-menu, NOT under the AdminGate'd `/settings` (the prefs API is open to every authenticated user, VIEWER included); (2) ship all 3 surfaces together for v1 | New `/account` route group. New dep `@microsoft/fetch-event-source`. Built via the worktree-lane pattern (foundation A ‖ SMTP B → bell C ‖ prefs D), each merged LOCALLY by SHA (no push), gated by a clean web build + en/es i18n parity + an adversarial multi-agent review (14 findings: 1 medium i18n-key-path that CI could NOT catch + 13 low/nit, ALL remediated). On `feat/settings_notifications_smtp` (HEAD e6ad92e), NOT yet on `dev`. Reusable design-system honored (warm-bone/indigo/Geist, WCAG-AA, heroicons, impeccable bans) |
| 2026-06-16 | **In-app Help/Manual built + standing Manual-sync rule** | ADR-0062 implemented end-to-end: public `/help` surface (#535/#560), nested IA manifest (#563), and the full operator content — 13 categories, 56 pages × en/es (#564), built via a 13-agent fan-out, all merged to dev | **Every user-facing change must also update its Manual page (en+es)** — encoded in `CLAUDE.md` #7, `claude-workflow.md` §5/DoD, `manual-authoring.md`, and the frontend prompt-template. The Manual is operator-facing product docs, distinct from the dev `docs/` vault and the KB |

---

## Superseded decisions

| Old ADR | Superseded by | Reason |
|---------|--------------|--------|
| ADR-0013 (custom ZodValidationPipe) | ADR-0018 (nestjs-zod global pipe) | nestjs-zod provides the pipe + Swagger integration |
| ADR-0019 actor source (body-supplied) | ADR-0024 (ActorService + X-User-Id shim) | Consolidated actor resolution; removed body actor |
| ADR-0022 + ADR-0016 (auth shim / auth deferred) | ADR-0037/0038/0039/0040/0043 (auth epic) | Auth delivered + validated live 2026-06-01; shim survives only as `AUTH_MODE=shim` (dev/test) |
| ADR-0040 default role `@default(MEMBER)` | ADR-0043 §5 (`@default(VIEWER)`) | Least-privilege default flipped MEMBER→VIEWER (uniform across app-create + non-first JIT) |
| ADR-0037 §6 manual OIDC-client registration (primary path) | ADR-0043 §4 (zero-touch sidecar + in-app wizard) | "One build, one run"; manual runbook kept as the BYOI/fallback path |
| ADR-0038 "roles never sync to the IdP" posture | ADR-0043 §3 (roles written back to Zitadel) | One-way mirror app→Zitadel; the reverse (token role→authZ) is explicitly NOT adopted |
| ADR-0040 authZ MECHANISM (`@Roles` + `RolesGuard`, hardcoded role→capability) | ADR-0046 (`@RequirePermission` + `PermissionGuard` + `PermissionResolverService`, configurable `RolePermission` matrix) | RBAC v2: 3 roles stay FIXED, but capabilities become a runtime-configurable permission catalog; the DB-first, per-domain philosophy is kept |
| ADR-0065 (regenerate the Secret Manager recovery key) | ADR-0066 (password=entry / recovery-key=fixed root) | Recovery-key rotation reverted; the root is fixed at bootstrap, its sole power is to reset the password |
| ADR-0071 (KB write-mode highlight overlay) | *reverted, no successor* (issue #803, 2026-06-24) | The overlay drifted caret↔glyph and was removed; the `[[`/`{{` autocompletes were kept |

---

## Open questions (not yet decided)

> Resolved since 2026-05-26 — moved out of this table: **IdP provider/database/BYOI surface** → ADR-0037/0043 (Zitadel bundled, own Postgres, `IdentityProvider` adapter); **frontend pagination** → ADR-0030 implemented on the heavy lists; **read-authorization** → ADR-0046 (every read GET `<domain>:read`-gated; the safe-default seed pre-tightens `accessGrant:read`/`user:read` to ADMIN+MEMBER); **non-human principals / API tokens** → ADR-0048 (Service Accounts).

| Question | Blocker | How to unblock |
|----------|---------|---------------|
| ~~Async workers (BullMQ + Redis) + a scheduler~~ | **RESOLVED** → **ADR-0053** (BullMQ on Valkey, sandboxed processors) + **ADR-0054** (Workflow Engine on that transport). SEC-002, the workflow engine, and email dispatch (ADR-0079) all unblocked. | — |
| **ServiceAccountAuditLog SA-actor column** (a SA managing another SA is attributed `null`) | Carved out of ADR-0048 | Its own future ADR when SA-on-SA attribution is needed |
| BYOI write-back interface (SCIM/webhook) + bidirectional role sync | Deferred in ADR-0043 (Fork #5) | When a BYOI customer needs write-back |
| CD / image publishing (GHCR + deploy flow + tagging) | Deferred in ADR-0027 (ADR-0052 parallelized CI docker builds but publishing/CD is still not built) | When a deploy target exists |
| E2E / integration testing tooling | Deferred in ADR-0012 | When critical flows stabilize |
| Settings backend (general app settings store) | **Partially resolved** — instance-config stores now exist per-concern: `AssetTagScheme` (ADR-0063), `SmtpSettings` (ADR-0079, *proposed*), the RolePermission matrix (ADR-0046). There is still **no single general key-value settings store**; the `/settings` web area remains ADMIN UI over discrete endpoints | When a general settings need appears that doesn't fit a purpose-built store |
| On-prem / internal-target workflow connectors (**ADR-0055 is *proposed***) | Awaiting acceptance; the `isInternalTargetAllowed` seam + IP classifier floor are already built | CEO acceptance of ADR-0055 |

---

## Update protocol

Update when:
- A new ADR is accepted → add entry under the right category
- An ADR is superseded → move to the superseded section, link both
- A non-ADR strategic decision lands → add to "Decisions made outside ADRs"
- An open question is resolved → move from "open" to its category
