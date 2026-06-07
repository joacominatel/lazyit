# Decision History

> This document is a **CTO-friendly index of major decisions** taken across the project — ADRs and broader strategic calls. It exists to let the CTO quickly check "is this already decided?" without reading thirty ADR files.
>
> **Owner**: CTO. Updated when a new ADR is accepted, or when a non-ADR strategic decision lands in a session.
>
> Initially populated: 2026-05-26 (first CTO session), from all 36 ADRs in `docs/03-decisions/`.
> Refreshed 2026-06-01 (post auth epic) — covered all 44 ADRs (0001–0044).
> Refreshed 2026-06-01 (post UX northstar cycle, PRs #100–#115) — now covers all 45 ADRs (0001–0045; ADR-0045 = heroicons) + the ADR-0011/0030 amendments.
> Refreshed 2026-06-03 (post RBAC v2 + Service-Accounts epic) — now covers all 48 ADRs (0001–0048; ADR-0046 = Roles & Permissions v2, ADR-0047 = `start.sh`, ADR-0048 = Service Accounts). Read-authorization is now CLOSED; `@Roles` retired in favor of `@RequirePermission`.

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

---

## Open questions (not yet decided)

> Resolved since 2026-05-26 — moved out of this table: **IdP provider/database/BYOI surface** → ADR-0037/0043 (Zitadel bundled, own Postgres, `IdentityProvider` adapter); **frontend pagination** → ADR-0030 implemented on the heavy lists; **read-authorization** → ADR-0046 (every read GET `<domain>:read`-gated; the safe-default seed pre-tightens `accessGrant:read`/`user:read` to ADMIN+MEMBER); **non-human principals / API tokens** → ADR-0048 (Service Accounts).

| Question | Blocker | How to unblock |
|----------|---------|---------------|
| Async workers (BullMQ + Redis) + a scheduler (cron/queue) | SEC-002 fix; expiry reminders / periodic role-sync; **now also gates backups-from-frontend + the Application workflow engine (P4)** | CEO decision; an ADR needed before implementation |
| **ServiceAccountAuditLog SA-actor column** (a SA managing another SA is attributed `null`) | Carved out of ADR-0048 | Its own future ADR when SA-on-SA attribution is needed |
| BYOI write-back interface (SCIM/webhook) + bidirectional role sync | Deferred in ADR-0043 (Fork #5) | When a BYOI customer needs write-back |
| CD / image publishing (GHCR + deploy flow + tagging) | Deferred in ADR-0027 | When a deploy target exists |
| E2E / integration testing tooling | Deferred in ADR-0012 | When critical flows stabilize |
| Settings backend (general app settings store) | Deferred; `/config` covers first-run only. The new `/settings` web area (#108) is ADMIN UI over existing endpoints (taxonomies, asset-models, roles, config-status) — no general settings store yet | When a general settings need appears |

---

## Update protocol

Update when:
- A new ADR is accepted → add entry under the right category
- An ADR is superseded → move to the superseded section, link both
- A non-ADR strategic decision lands → add to "Decisions made outside ADRs"
- An open question is resolved → move from "open" to its category
