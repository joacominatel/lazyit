# System Map

> This document is the CTO's mental model of the entire lazyit system: what exists, where it lives, how parts connect, and what state each module is in. It is the **first reference loaded** at every CTO session.
>
> **Not redundant with `docs/`**: that documents the system formally and per-module. This file is the CTO's cross-cutting condensed view — the version that answers "do I understand the whole system enough to coordinate work on it?"
>
> **Owner**: CTO. Initially populated during the first investigation session. Updated at the end of every session where the system changed materially.

---

## How to read this file

This file is structured for **scanning, not reading end-to-end**. The CTO opens it, jumps to the section relevant to the current task, and decides from there.

---

## High-level shape

> **Monorepo**: Bun `1.3.14` workspaces + Turborepo `^2.9`
> **Apps**: `apps/api` (NestJS `11.0.1`), `apps/web` (Next.js `16.2.6` + React `19.2.4`)
> **Shared**: `packages/shared` (zod schemas, types, utilities)
> **Infra**: consolidated root `compose.yaml` (canonical, all services) + committed `compose.override.yaml` (dev tuning) + a `prod` profile + a thin `infra/docker-compose.prod.yaml` overlay; Caddy, env templates, Dockerfiles, bootstrap scripts
> **Docs**: `docs/` (Obsidian vault — 48 ADRs (0001–0048) as of 2026-06-03) + `docs/06-security/INVARIANTS.md` (the 7 auth non-negotiables + INV-8 [ADMIN immutable/full] + the INV-SA-1..4 Service-Account guardrails)
> **Skills**: `.claude/skills/` (cto, navigator, devops, sentinel, remediator)

Ports: Web → `:3000` · API → `:3001` · Postgres → `:5432` (loopback) · Meilisearch → `:7700` (loopback). In prod only Caddy publishes ports (8080/8443 by default); db/api/web/zitadel stay internal.

---

## Backend (`apps/api`)

### Framework and runtime

- NestJS `11.0.1` application, runs on Node 24/26 in CI/prod
- Entry point: `apps/api/src/main.ts`
- Module registry: `apps/api/src/app.module.ts`
- Runs under Node at runtime (Bun is for build/tooling only — ADR-0009)

### Modules currently registered

| Module | Folder | Primary entities | Status |
|--------|--------|-----------------|--------|
| AuthModule (`@Global`) | `auth/` | JwtAuthGuard + PermissionGuard (two ordered APP_GUARDs), PermissionResolverService, @CurrentUser()/@CurrentPrincipal()/@RequirePermission()/@Public() decorators, `IDENTITY_PROVIDER` (IdP write-back seam); SA-token branch in JwtAuthGuard | stable — RBAC v2 + Service Accounts delivered (ADR-0046/0048); `@Roles` RETIRED |
| CommonModule | `common/` | ActorService, AllExceptionsFilter, PrismaExceptionFilter, ParseUuidQuery | stable |
| PrismaModule | `prisma/` | PrismaService + soft-delete extension | stable |
| SearchModule | `search/` | SearchService (Meilisearch), GET /search | stable |
| HealthModule | `health/` | `@Public()` GET /health/live + /health/ready (hand-rolled, no terminus) | stable |
| ConfigModule | `config/` | `@Public()` GET /config/status + idempotent CSRF+rate-limited POST /config/setup (first-ADMIN bootstrap, ADR-0043 §4); **NEW (ADR-0046)**: GET/PUT `/config/permissions` (the RolePermission matrix, `settings:manage`) + GET `/config/my-permissions` (the caller's effective permission set, for UI gating) | stable |
| ServiceAccountsModule | `service-accounts/` | **NEW (ADR-0048)** — ServiceAccount + ServiceAccountPermission CRUD (`settings:manage`); mints/rotates a lazyit-native hashed token (`lzit_sa_<id>_<secret>`, one-time secret reveal); direct permission grants from the same catalog (never ADMIN/Role); fail-closed | stable |
| DashboardModule | `dashboard/` | GET /dashboard/summary (cross-pillar counts) + GET /dashboard/activity (recent_activity VIEW, ADR-0044) — read-only, no schema | stable |
| AssetHistoryModule | `asset-history/` | AssetHistory (read-only, no controller) | stable |
| UsersModule | `users/` | User + role management (GET /users/me, set-role, last-admin/self guards) + ADMIN-gated CRUD + IdP write-back; **list now `Page<T>` + server `q`/sort/`deleted` (#104/#114)** | stable |
| LocationsModule | `locations/` | Location; **list now `Page<T>` + server `q`/sort/`deleted` (#104/#114)** | stable |
| AssetCategoriesModule | `asset-categories/` | AssetCategory | stable |
| AssetModelsModule | `asset-models/` | AssetModel | stable |
| AssetsModule | `assets/` | Asset (specs jsonb custom fields) + restore; **batch `POST /assets/batch/{delete,restore,status}` (ADMIN, #104)**; reverse KB endpoint `GET /assets/:id/articles` (#104) | stable |
| AssetAssignmentsModule | `asset-assignments/` | AssetAssignment | stable |
| ArticleCategoriesModule | `article-categories/` | ArticleCategory | stable |
| ArticlesModule | `articles/` | Article + append-only ArticleVersion + ArticleLink (article↔asset/app), .docx import, content indexed (ADR-0042) | stable |
| ApplicationCategoriesModule | `application-categories/` | ApplicationCategory | stable |
| ApplicationsModule | `applications/` | Application; **list now `Page<T>` + server `q`/sort/`deleted` (#104/#114)**; reverse KB endpoint `GET /applications/:id/articles` (#104) | stable |
| AccessGrantsModule | `access-grants/` | AccessGrant (ADMIN-gated writes); **batch `POST /access-grants/batch/revoke` (ADMIN, #104 — data layer ready, no owned UI)** | stable |
| ConsumableCategoriesModule | `consumable-categories/` | ConsumableCategory; **added to ADR-0032 `SOFT_DELETABLE_MODELS` (#114) — was leaking soft-deleted rows** | stable |
| ConsumablesModule | `consumables/` | Consumable + ConsumableMovement (int4-guarded, stock-race-safe); **list now `Page<T>` + server `q`/sort/`deleted`; FIXED a pre-existing soft-delete leak (Consumable/ConsumableCategory were missing from `SOFT_DELETABLE_MODELS`, #114)** | stable |
| LoggingModule (via LoggerModule.forRoot) | `logging/` | Pino config (ADR-0031) | stable |

Module registration order is load-bearing in two places: `LoggerModule.forRoot(...)` is imported first (wraps every route), and inside AuthModule the two `APP_GUARD`s run in registration order — `JwtAuthGuard` (sets `request.user` from an OIDC JWT / shim, OR resolves a ServiceAccount principal on the SA-token branch) **then** `PermissionGuard` (enforces `@RequirePermission()` via PermissionResolverService). `RolesGuard`/`@Roles` are gone — authZ is now the single `@RequirePermission` primitive.

### Cross-cutting middleware and global services

- **ZodValidationPipe** (global, APP_PIPE) — validates every `@Body` typed with `createZodDto`
- **AllExceptionsFilter** (global, APP_FILTER) — logs >=500 errors with stack; delegates Prisma errors to PrismaExceptionFilter
- **PrismaExceptionFilter** — maps P2002→409, P2003/P2023→400, P2025→404
- **JwtAuthGuard** (from AuthModule, global APP_GUARD #1, **authentication**) — validates OIDC Bearer JWT via JWKS (RS256-pinned) or reads X-User-Id in `AUTH_MODE=shim` (prod-guarded off). Resolves `request.user` (User entity) from the DB by `externalId`/id; JIT-provisions + email-account-links on first OIDC login (ADR-0038/0043). **NEW (ADR-0048): a Service-Account-token branch** — a `lzit_sa_<id>_<secret>` Bearer is hashed, looked up + verified, and resolves a **ServiceAccount principal** (not a User) onto `request`; fail-closed. Honors `@Public()`
- **PermissionGuard** (from AuthModule, global APP_GUARD #2, **authorization**, ADR-0046) — runs after JwtAuthGuard; reads `@RequirePermission(...)` metadata and asks **PermissionResolverService** whether the principal holds it (403 otherwise). Unannotated route → any authenticated principal; `@Public()` → skip. **Authorization is DB-first**: a token role/permission claim is NEVER an authZ source (INV-1). Replaced the retired `RolesGuard`
- **PermissionResolverService** (from AuthModule, ADR-0046) — the single authZ resolver. For a **User**: ADMIN short-circuits to all-permissions (INV-8); otherwise reads the `RolePermission` rows for the user's role. For a **ServiceAccount**: reads its direct `ServiceAccountPermission` grants (never a Role, never ADMIN). DB-first, **cached** (invalidated on matrix/grant change), **fail-closed**
- **@CurrentUser()** / **@CurrentPrincipal()** / **@RequirePermission()** / **@Public()** (decorators) — User extraction, User-or-SA principal extraction (used for actor attribution: human → actorId, SA → null + serviceAccountId), permission-gating, and auth bypass respectively. `@Roles()` is retired
- **IdentityProvider** (`auth/identity/`, DI token `IDENTITY_PROVIDER`, ADR-0043) — the IdP write-back seam. An `IdentityProvider` interface + `GenericOidcIdentityProvider` (BYOI; management methods no-op + warn) + `ZitadelIdentityProvider`, selected by a factory keyed on `IDENTITY_PROVIDER_TYPE` (`zitadel` | `generic-oidc`, default `zitadel`). `ZitadelManagementService` does the real Management-API write-back (see Auth section)
- **ActorService** (from CommonModule, exported globally) — now trivial: `resolve(user?: User) → user?.id`. DB lookup removed (guard handles it). Used by: Assets, AssetAssignments, AccessGrants, Articles, Consumables
- **Pino / nestjs-pino** — structured logging; X-Request-Id propagated end-to-end
- **Soft-delete Prisma extension** — automatically adds `deletedAt: null` to every `findMany`/`findFirst`/`findUnique` query; `includeSoftDeleted` escape hatch used by restore endpoints (ADR-0041)
- **CORS** — origin from `WEB_ORIGIN` env (default `http://localhost:3000`); `credentials: true`; exposes `X-Request-Id`
- **Swagger/OpenAPI** — `/api/docs` (UI) + `/api/docs-json` (raw JSON). **NOT mounted in prod (SEC-009 closed)** — gated off when `NODE_ENV=production`; available in dev only
- **SearchService** — exported from SearchModule; injected by Assets, Articles, Users, Locations, Applications for fire-and-forget Meili sync. No-ops if `MEILI_HOST` is unset

### Database

- PostgreSQL `18-alpine` via Prisma `7.8.0` with `@prisma/adapter-pg`
- Schema at `apps/api/prisma/schema.prisma`
- Migrations at `apps/api/prisma/migrations/`
- Seed script at `apps/api/prisma/seed.ts`
- Generated client at `apps/api/generated/prisma` (gitignored; generated in CI)

### Auth status — Zitadel source-of-truth (ADR-0043, "Option B"), validated live 2026-06-01

The auth epic is **delivered and validated end-to-end live on 2026-06-01** (a zero-touch first boot:
`docker compose … --profile prod up -d --build` from `.env.prod`, no hand-copied OIDC client → bundled
Zitadel + sidecar provisioning + in-app `/setup` wizard creating the first ADMIN, mirrored back into
Zitadel). The seven non-negotiables are codified in `docs/06-security/INVARIANTS.md` (INV-1..7).

**Authentication (AuthN) — `JwtAuthGuard`, generic OIDC, unchanged envelope**
- OIDC mode (prod): validates Bearer JWT via JWKS using `jose`, **RS256-pinned**; rejects `isActive=false` users; 401 on missing/invalid token. `AUTH_MODE=shim` (dev/tests only) reads `X-User-Id`; **prod-guarded** so it can't be enabled in production.
- **JIT provisioning + email account-linking** (ADR-0038/0043, INV-2): on first OIDC login, claims a **live `externalId IS NULL` row by verified email** (a race-safe `updateMany` guarded on `externalId: null`), never re-binds a different `sub`, and never resurrects a soft-deleted row (`externalId` stays fully `@unique`). This fixed a per-request 409. JIT **no-resurrect** of offboarded users is intentional (403).
- `User.externalId` — the OIDC `sub`. Nullable but **fully `@unique`** (deliberately NOT a partial index — the upsert/link path needs a true unique key, ADR-0041).

**Authorization (AuthZ) — RBAC v2 (Roles & Permissions), DB-first (ADR-0046, supersedes the ADR-0040 mechanism, INV-1)**
- The **3 roles are FIXED** — `enum Role { ADMIN MEMBER VIEWER }` on `User`, **`@default(VIEWER)`** (ADR-0043) — but each role's **permissions are fully configurable** at runtime. ADMIN is **immutable + always-full** (INV-8); MEMBER/VIEWER are tunable. The **first user ever on an empty DB stays ADMIN** so an install is never un-administrable.
- **Permission catalog-as-code** in `@lazyit/shared` (33 permissions, `<domain>:<verb>`); a `RolePermission` table holds the (role × permission) matrix, seeded from `buildDefaultRolePermissions` (a **safe-default** seed). Coarse verbs (`settings:manage`/`user:manage`/`accessGrant:grant`) + `<domain>:read` + per-domain writes/`:delete`.
- `PermissionGuard` + `@RequirePermission(...)` enforce it via `PermissionResolverService`: ADMIN short-circuits to full (INV-8); others resolve from the DB matrix. **41 read GETs are now annotated `<domain>:read`; 63 write gates migrated** off `@Roles`. **The token claim is never an authZ source** — every decision re-reads the DB matrix (INV-1).
- **Read-authorization is CLOSED** (was the headline Medium debt): the seed pre-tightens `accessGrant:read` + `user:read` to **ADMIN+MEMBER** (VIEWER cannot read them by default), while keeping operators able to grant any verb to any role.
- The matrix is **fully configurable, with friction not blocks**: `:delete` and the coarse `settings:manage`/`user:manage`/`accessGrant:grant` verbs CAN be granted to MEMBER/VIEWER — surfaced with a ⚠ in the editor (admin-initiated delegation, accepted; no server-side prohibition). BYOI-safe: **permissions are never synced to the IdP** (Zitadel mirrors identity + the 3 roles only).
- **Service-Account authZ** (ADR-0048): a ServiceAccount holds **direct** `ServiceAccountPermission` grants from the same catalog — never a Role, never ADMIN; PermissionResolverService resolves them the same way; fail-closed.
- **Role management** (ADR-0040 Round 3): `GET /users/me` returns the caller incl. role (the token doesn't carry it, so the web reads role here to gate admin UI); a **last-admin guard** (409 refusing to demote/offboard/delete the final live ADMIN) and a **no-self-role-change** guard (403); a `apps/api/scripts/set-role.ts` (`bun run set-role <email> <ROLE>`) bootstraps the first ADMIN on a non-empty DB.

**Zitadel as source of truth + write-back (ADR-0043 §3, INV-4/5)**
- `IdentityProvider` adapter (`auth/identity/`): `ZitadelIdentityProvider` + `ZitadelManagementService` (a real, ~21KB implementation) write back via the Zitadel **Management API**, authenticated by a **Private-Key JWT** service account (RFC 7523, RS256). User CRUD uses the **v2** resource API (`POST /v2/users/human`, `…/{id}/deactivate`); **user-grants use the v1 endpoints** (`/management/v1/users/{id}/grants` + `…/grants/_search`) — the v2 `/v2/users/{id}/grants` form 404s on Zitadel v2.68.0 (as-built fix #95). `grantRole` is set-role.
- Write-back is wired into the ADMIN-gated Users controller: create → local VIEWER mirror then `idp.createUser`; role change → local update then `idp.grantRole`; offboard → `idp.deactivateUser` **inside the offboard transaction**. A Management failure rolls back / compensates and surfaces **503** — no split-brain (INV-5). `setup()` is the one deliberate exception (degrades, keeps local ADMIN, warns).
- **BYOI degrades gracefully** (INV-4): `GenericOidcIdentityProvider` no-ops all management with a `warn` (`supportsManagement=false`); the Management API is never on the login path; a missing Management credential warns at boot, never blocks.

**First-run setup wizard (ADR-0043 §4, INV-3)**
- `GET /config/status` (`@Public()`) reports `{ isConfigured, adminCount, integrationMode }`; the in-app full-screen `/setup` wizard creates the first ADMIN via `POST /config/setup` — **idempotency-gated** (409 once any ADMIN exists), **CSRF**-protected (stateless HMAC double-submit), **rate-limited per IP**, and audited. "One build, one run": the infra `zitadel-bootstrap` sidecar does the zero-touch Zitadel plumbing; the wizard confirms the integration mode + creates the ADMIN; BYOI-safe (skip the Zitadel step).

**Frontend auth (ADR-0039)** — Auth.js v5 (`apps/web/auth.ts`), login redirects to IdP then `/dashboard`; route guard; Bearer injection via `session-token` store + `SessionTokenSync`. The `UserSwitcher`/`acting-user.ts` dev shim is removed.

**Prod-stack gotchas** (still apply) — see [[prod-oidc-stack]] memory: Caddy merges byte-identical `handle` blocks (exclude `/api/auth/*` from `@api`); Auth.js discovery uses `provider.issuer` (rewrite to the internal origin in `customFetch`); internal calls send `X-Forwarded-Host`/`-Proto`; `AUTH_URL` required; Zitadel `--tlsMode external`. Zitadel app config: Auth Token Type = JWT + User Info inside ID Token = on; redirect URI `/api/auth/callback/oidc`. `ZITADEL_MASTERKEY` must be **exactly 32 bytes**. New env vars include `IDENTITY_PROVIDER_TYPE`, `ZITADEL_MGMT_SA_KEY_PATH`, `OIDC_CLIENT_FILE`, plus the prior `OIDC_*`/`AUTH_*` set.

**Supersedes**: ADR-0043 extends (does not replace) ADR-0037/0038/0040 — it flips the default role to VIEWER, replaces the manual OIDC-client console chore with the sidecar+wizard as the primary path, and adds roles-written-back-to-Zitadel. It keeps the trusted-IdP assumption, JIT, account-linking, RS256 pinning, the guard ordering, and the 3-env-var BYOI envelope.

---

## Frontend (`apps/web`)

### Framework and conventions

- Next.js `16.2.6` (App Router) + React `19.2.4`
- Tailwind v4 + shadcn/ui (preset `radix-nova`, base `neutral`)
- **Palette (Round 1 #65 + Round 3 #81 + UX cycle #102)**: softened neutral — warm bone (light) + dark warm gray (dark), keeping the indigo brand accent. UX cycle (#102, ADR-0011 amendment 3) **activated + tuned** the `--success/--warning/--info` (+fg) tokens for AA contrast on the bone canvas (solid pills, light + dark) and repurposed `--chart-1..5` as the **categorical / avatar palette** (`lib/avatar-color.ts` → `avatarColorFor`). KB markdown rendered via `rehype-sanitize` (closes SEC-003 render-time XSS). Mobile nav added.
- TanStack Query for data layer (ADR-0020); `keepPreviousData` on paginated lists
- react-hook-form + zodResolver for forms (the 5 hand-rolled detail/edit dialogs converged onto this in #111 — Field/FieldError/aria-invalid, onTouched, scroll-to-error)
- **URL is the source of truth for list state** (#105/#110): `useListParams` maps `q`/`sort`/`dir`/`page`/`deleted`/client-filters to the URL and onto the #104 server params
- next-themes for dark mode; Sonner for toasts
- **heroicons ONLY** — `lucide-react` was dropped entirely in #115 (ADR-0045): the 6 vendored shadcn primitives + sonner were re-skinned to heroicons, two-weight convention (`24/outline` default + `16/solid` inline). No lucide anywhere in the tree.

### Route groups

- `(app)` — authenticated app (Auth.js session; sidebar layout in `app/(app)/layout.tsx`). Sidebar is grouped into **3 product pillars + Manage** (#100): **Inventory** (Assets, Consumables) · **Access** (Applications) · **Knowledge** (KB) · **Manage** (Users, Locations, Settings [ADMIN-only])
- `(auth)` — login flow (functional; redirects to IdP). **First-run onboarding gate**: login + marketing surfaces read `GET /config/status` and, when `isConfigured === false`, surface a prominent "Set up lazyit" link to `/setup` (fail-safe — no link if the API is down) so a fresh operator is never stranded
- `(marketing)` — landing / public surface (minimal; carries the same first-run "Set up lazyit" gate). Also hosts the **public Help/Manual** at `/help` (ADR-0062, #535/#560/#563/#564): login-free product docs from markdown in `apps/web/content/manual/{en,es}/`, nested IA (Category→Subcategory, manifest `_nav.ts`), sidebar + simple client-side search. **Standing rule:** every user-facing change updates its Manual page (en+es) — see `manual-authoring.md` / `CLAUDE.md` #7
- `app/setup` — full-screen first-run wizard (top-level, outside `(app)`; ADR-0043)
- `app/api/auth/[...nextauth]` — Auth.js route handler

### Live screens (functional as of 2026-06-01 — post UX cycle)

All **list pages** now share the same chrome (#100/#110): `PageHeader` + route-driven `Breadcrumb` +
accessible `SearchInput`; write affordances **permission-gated** via `can(permission)` (the old
`useCanWrite`/`isAdmin` gating was migrated wholesale to fine-grained `can(...)`, RBAC v2); URL-driven
list state → server `q`/`sort`/`dir` + real pagination UI; `ActiveFilters` chips; an ADMIN-only "Show
archived" toggle (`deleted=only`) + per-row Restore. All **detail/edit/new pages** use `DetailPanel`/`DetailField`/
`DetailSkeleton` + PageHeader/Breadcrumb + the shared `ErrorState`, with cross-links (Location, owner/actor,
Category/Model) to detail routes.

| Route | Screen | Notes |
|-------|--------|-------|
| `/setup` | First-run wizard | 4-step: welcome/integration choice → optional Zitadel config → create first ADMIN → done. Self-locks once an ADMIN exists (ADR-0043) |
| `/dashboard` | Dashboard | **Wired** to GET /dashboard/summary (counts) + a Recent-activity panel (infinite query over GET /dashboard/activity, ADR-0044). #110 added: "Needs attention" cards **deep-link to pre-filtered lists**, freshness/Refresh, ADMIN quick-actions, shared ErrorState |
| `/assets` | Asset list | ResourceTable + server q/sort/pagination; **server-side bulk** delete/status/restore (#104/#112) via row selection + BatchActionBar; archived toggle + per-row Restore; departed owners dimmed |
| `/assets/new` | Create asset | Full form with inline creatable fields + custom-fields editor (specs jsonb) |
| `/assets/[id]` | Asset detail | DetailPanel; Assignments + AssetHistory timeline; Category/Model + Location + owner cross-links; **"Related articles"** panel (KB runbooks, #111) |
| `/assets/[id]/edit` | Edit asset | Same form (RHF+zod) |
| `/locations` | Location list | ResourceTable + server q/sort/pagination; **type filter is CLIENT-side** over the page (no backend param); bulk restore (client per-id fan-out) + archived toggle |
| `/locations/[id]` | Location detail | DetailPanel; "assets here" + cross-links |
| `/users` | User list | Per-row role (UserRoleSelect/Badge); server q/sort/pagination; **status filter CLIENT-side**; bulk restore (client per-id fan-out) + archived toggle |
| `/users/[id]` | User detail | DetailPanel; profile + role management (ADMIN-only Select, confirmation, 409/403 surfaced) |
| `/kb` | KB article list | Draft/published, author visibility; PageHeader/SearchInput |
| `/kb/new` | Create article | Markdown editor + .docx import |
| `/kb/[slug]` | Article detail | DetailPanel; Markdown rendered, `rehype-sanitize` (SEC-003 closed); **"Linked to"** panel (linked assets/apps, #111) |
| `/kb/[slug]/edit` | Edit article | Markdown editor |
| `/applications` | Application list | Grant access inline; server q/sort/pagination; **category/criticality filters CLIENT-side** over the page |
| `/applications/new` | Create application | Full form |
| `/applications/[id]` | Application detail | DetailPanel; grant list + revoke (grants live here — there is no owned grants table); **"Related articles"** panel (#111) |
| `/applications/[id]/edit` | Edit application | |
| `/consumables` | Consumable list | Stock badges + one-click +1/-1 quick-adjust; server q/sort/pagination; bulk restore (client per-id fan-out) + archived toggle |
| `/consumables/new` | Create consumable | |
| `/consumables/[id]` | Consumable detail | DetailPanel; movement ledger + quick-adjust |
| `/consumables/[id]/edit` | Edit consumable | |
| `/settings` | Settings landing | **NEW (#108)** — ADMIN-gated (`admin-gate.tsx`) admin area landing |
| `/settings/taxonomies` | Taxonomies CRUD | CRUD for the 4 category kinds + asset-models (completed the web category/model write data layer) |
| `/settings/roles` | Roles overview | Roles reference (links to the permissions editor) |
| `/settings/roles/permissions` | **Permissions matrix editor (NEW, ADR-0046)** | **Role-first** editor (NOT a grid): pick a role → presets + capability toggles + fine-tune, over GET/PUT `/config/permissions`. ADMIN row immutable/full; ⚠ on delegating `:delete`/coarse verbs to MEMBER/VIEWER |
| `/settings/service-accounts` | **Service Accounts (NEW, ADR-0048)** | CRUD over `/service-accounts`; create → **one-time secret reveal** (`lzit_sa_…`, shown once); per-SA permission grants from the catalog; rotate/revoke |
| `/settings/instance` | Instance config-status | Reads `GET /config/status` (integration mode, configured state) |
| `/login` | Login page | Functional — redirects to IdP; first-run "Set up lazyit" gate |

### Shared components and primitives

**Chrome & layout primitives (UX cycle #100/#102/#111)**

| Component | Location | Purpose |
|-----------|----------|---------|
| `PageHeader` | `components/page-header.tsx` | Standard page title + actions header (all list/detail/new/edit) |
| `Breadcrumb` | `components/breadcrumb.tsx` | Route-driven breadcrumb |
| `SearchInput` | `components/search-input.tsx` | Accessible debounced search box (lists) |
| `ActiveFilters` | `components/active-filters.tsx` | Dismissible filter chips reflecting the URL list state |
| `DetailPanel` / `DetailField` / `DetailSkeleton` | `components/detail-panel.tsx` | Shared detail layout + labelled fields + loading skeleton (all 5 detail pages + KB) |
| `StatusBadge` / `StatusDot` | `components/ui/status-badge.tsx` | Tone-based status pill/dot (`tone: success\|warning\|info\|danger\|neutral`); the per-entity status badges were refactored onto it (#102) |
| `Checkbox` | `components/ui/checkbox.tsx` | shadcn checkbox primitive (powers row selection) |

**Reusable feature components**

| Component | Location | Purpose |
|-----------|----------|---------|
| `ResourceTable` (+ `SelectCell`, `ResourceCard`, `ResourceCardMeta`, `RestoreRowAction`, `BatchActionBar`) | `components/resource-table.tsx` | Responsive table — `mobileChildren`/`ResourceCard` for the card layout below sm; row **selection** + `BatchActionBar` for bulk actions; per-row Restore (#110/#112) |
| `DeleteConfirmDialog` | `components/delete-confirm-dialog.tsx` | Reusable soft-delete confirmation |
| `GlobalSearch` | `components/global-search.tsx` | Cmd+K palette, calls GET /search (icon-only below sm in the mobile shell) |
| `MarkdownEditor` | `components/markdown-editor.tsx` | KB editing surface |
| `MarkdownView` | `components/markdown-view.tsx` | KB rendering, `rehype-sanitize` allow-list (SEC-003 closed) |
| `CreatableField` | `components/creatable-field.tsx` | Inline "New" beside selects → dialog → auto-select |
| `CreateCategoryDialog` | `components/create-category-dialog.tsx` | Reusable category inline create |
| `CreateAssetModelDialog` | `components/create-asset-model-dialog.tsx` | Reusable model inline create |
| `UserAvatar` | `components/user-avatar.tsx` | Avatar from user initials (color via `lib/avatar-color.ts` `avatarColorFor`) |
| `UserMenu` | `components/user-menu.tsx` | Topbar user menu (+ role badge, #105) |
| `RequestIdNote` | `components/request-id-note.tsx` | Copy-to-clipboard request ID in error surfaces |
| `ThemeToggle` | `components/theme-toggle.tsx` | Dark/light mode |
| `SidebarNav` | `components/sidebar-nav.tsx` | App navigation — 3 pillars + Manage (#100); mobile shell gutter |
| `UserRoleSelect` / `UserRoleBadge` | `app/(app)/users/_components/` | Role read-only badge vs ADMIN-only Select (reads `GET /users/me`) |
| `CustomFieldsEditor` | `app/(app)/assets/_components/custom-fields-editor.tsx` | Edits the asset `specs` jsonb |
| `QuickAdjustButtons` | `app/(app)/consumables/_components/quick-adjust-buttons.tsx` | One-click +1/-1 stock movement |
| `RecentActivityPanel` | `app/(app)/dashboard/_components/recent-activity-panel.tsx` | Infinite-query feed over GET /dashboard/activity |
| `SetupWizard` (+ steps) | `app/setup/_components/` | First-run wizard (welcome → configure → create-admin → done) |
| Settings managers | `app/(app)/settings/_components/` | `admin-gate.tsx`, `category-manager`/`category-form-dialog`, `asset-model-manager`/`asset-model-form-dialog` (#108) |

**Hooks (UX cycle #105/#111/#112)**

| Hook | Location | Purpose |
|------|----------|---------|
| `usePermissions` / `can(permission)` | `lib/hooks/use-permissions.ts` | RBAC v2 gating in the UI — reads the caller's effective permission set from GET `/config/my-permissions`; `can('<domain>:<verb>')` gates every write affordance. **`useCanWrite` is RETIRED** (the old `isAdmin`-coarse gating was migrated to fine-grained `can()`); **fails closed** while loading |
| `useListParams` | `lib/hooks/use-list-params.ts` | URL-as-source-of-truth list state → the #104 server params (`q`/`sort`/`dir`/`page`/`deleted`) |
| `useRowSelection` | `lib/hooks/use-row-selection.ts` | Row-selection state for bulk actions |
| `useArticleLinks` | `lib/api/hooks/use-article-links.ts` | KB runbook links (over `lib/api/endpoints/article-links.ts` → the reverse `GET /assets/:id/articles` + `GET /applications/:id/articles`) |
| `useDebouncedValue` | `lib/hooks/use-debounced-value.ts` | Debounce for the search input |

### Error UX (delivered sub-issue #30, 2026-05-26) + error boundaries (Round 1 #65)

- `app/(app)/error.tsx` — Next.js error boundary: shows request ID from ApiError, "Try again" button
- `RequestIdNote` — inline request ID with copy-to-clipboard (used in error boundary and list error states)
- `lib/api/notify-error.ts` — inline mutation errors via Sonner toast
- Round 1 (#65) added route-level error boundaries leveraging `x-request-id` end-to-end

### Data layer convention (ADR-0020)

- `lib/api/endpoints/*.ts` — pure fetch wrappers (one file per entity); paginated endpoints unwrap the `Page<T>` envelope (`.items`, ADR-0030). The 4 newly server-paginated lists (applications/consumables/users/locations) unwrap `.items` too (#106 hotfix — the #104 contract briefly merged ahead of its web consumer)
- `lib/api/hooks/*.ts` — TanStack Query hooks (incl. `useUserMe`, `useConfigStatus`, `useDashboardActivity` infinite query, `useArticleLinks`, the bulk/restore mutations)
- `lib/api/per-id-batch.ts` — client-side per-id fan-out helper for resources WITHOUT a server batch endpoint (consumables/users/locations bulk restore); mirrors the server `{requested,succeeded,skipped}` shape
- **Server batch endpoints** (#104): `POST /assets/batch/{delete,restore,status}` + `POST /access-grants/batch/revoke` (ADMIN, body `{ids}`, one audit entry per item). Assets bulk is wired to the UI; access-grants bulk-revoke data layer (`useBatchRevokeGrants`) **exists but is NOT wired** (no owned grants table)
- `lib/api/query-keys.ts` — query key factory per entity
- `lib/api/client.ts` — base fetch; Bearer injection from the Auth.js `session-token` store (the X-User-Id/`acting-user.ts` dev shim was removed with auth)
- Pages and components consume hooks; never call endpoints directly

---

## Shared (`packages/shared`)

Compiled CJS + d.ts (ADR-0014). Exported via barrel `src/index.ts`.

**Schemas (zod + inferred types)**:
- access-grant, access-grant-list, application, application-category
- article, article-category, article-list, article-version, article-link
- asset, asset-assignment, asset-category, asset-expanded, asset-history, asset-list, asset-model
- consumable, consumable-category, consumable-movement
- location, primitives, search, user (incl. `RoleSchema`/`Role`, `roleSource`)
- **pagination** (`PageQuerySchema`, `Page<T>` via `pageSchema()`, `offsetOf()`/`pageOf()` helpers — ADR-0030). The UX cycle (#104, ADR-0030 amendment §6) added **`sort`** + **`dir`** (`asc`|`desc`) and (#114, §7) **`deleted`** (`active`|`only`) to `PageQuerySchema`. The shape only validates well-formed strings; the **sortable-field set is a per-resource ALLOWLIST** (unknown sort → 400); `deleted=only` is ADMIN-only (400 on invalid)
- **config** (setup/status contract — ADR-0043)
- **permission** (RBAC v2, ADR-0046): the **Permission catalog** (33 entries), `PermissionSchema`, `RolePermissionMatrix`, `buildDefaultRolePermissions` (safe-default seed), and the editor metadata `PERMISSION_META` / `CAPABILITIES` / `PRESETS` + the **clone-defaults** helper
- **service-account** (ADR-0048): ServiceAccount create/update/response + token + permission-grant schemas
- **dashboard** (`DashboardSummarySchema`), **recent-activity** (`RecentActivityItemSchema` + `RecentActivityPageSchema` — ADR-0044)
- **api-error** (typed ApiError shape)

**Utils**: `slug` (kebab-case generator)
**Constants**: `APP_NAME`

All schemas are `z.strictObject` or equivalent — unknown keys rejected at the boundary. List endpoints return a `Page<T>` envelope; `EmailSchema` normalizes (`trim`+`toLowerCase`) for the citext column (ADR-0041).

---

## Infrastructure

### Compose topology — consolidated (Round 1 #66 + auth epic)

The old root `docker-compose.yml` and `infra/docker-compose.prod.yml` are **gone**. One canonical file now drives both dev and prod:

- **`compose.yaml`** (repo root, canonical) — every service. Backing services (`db`, `meilisearch`, `zitadel`, `zitadel_db`) are **unprofiled** → come up by default for dev. App + edge services (`migrate`, `api`, `web`, `caddy`, `backup`) plus the bootstrap sidecars carry **`profiles: [prod]`** → only under `--profile prod`.
- **`compose.override.yaml`** (committed, dev tuning) — auto-merged on plain `docker compose up`; drops prod-only host-port bindings etc.
- **`infra/docker-compose.prod.yaml`** (thin overlay) — applied with `-f compose.yaml -f infra/docker-compose.prod.yaml --profile prod --env-file infra/env/.env.prod`. Adds prod-only wiring (read-only secret mounts, the `zitadel-secrets-init` → `zitadel` edge).
- **Hardening (#66)**: image digest pins, `mem_limit`s, json-file log rotation, and a `backup` sidecar (DB dumps) per the backups runbook.

### Services (prod merge)

- `db` (Postgres `18-alpine`, internal), `migrate` (one-shot migrate+seed), `api`, `web`, `meilisearch` (internal — **now in prod**, closing the ADR-0035 gap), `zitadel_db` (internal), `zitadel` (internal), `caddy` (8080/8443 external), `backup` (DB dump sidecar).
- **Zero-touch Zitadel sidecars** (auth epic):
  - `zitadel-secrets-init` — one-shot root container that `chmod`s the `zitadel_secrets` volume before Zitadel boots, so the non-root Zitadel uid can export its FirstInstance machine key (as-built #93).
  - `zitadel-bootstrap` — one-shot, **fail-loud** sidecar (`infra/docker/zitadel-bootstrap.Dockerfile` + `infra/scripts/zitadel-bootstrap.sh`). Authenticates with the exported PAT, polls `/debug/healthz` (the shell-less Zitadel image has no healthcheck, #94), then **upserts the `lazyit` project + OIDC app + ADMIN/MEMBER/VIEWER project roles + a runtime service-account key**, writing `oidc-client.json` + `sa-key.json` into the `zitadel_secrets` volume. `api`/`web` `depends_on: zitadel-bootstrap (completed_successfully)` and read those files at startup (no hand-copied creds).
- **`zitadel_secrets`** named volume — internal-only; carries `oidc-client.json` (`0644` on a single-host internal volume — accepted tradeoff) + `sa-key.json` + the machine key (`0600`). INV-6.
- Caddy routes: `/api/docs*` → api (no strip), `/api/auth/*` → web (Auth.js, no strip — excluded from `@api`), `/api/*` → api (strip `/api`), `/` → web, `auth.{LAZYIT_DOMAIN}` → zitadel (ADR-0026/0037). Caddy handles TLS + same-origin `/api` routing.
- Secrets via `infra/env/.env.prod` (`chmod 600`, gitignored; ADR-0028). `ZITADEL_MASTERKEY` exactly 32 bytes (the DR linchpin). Bootstrap runbook: `docs/05-runbooks/auth-bootstrap.md`.
- **`start.sh`** — **NEW (ADR-0047)**: a guided, **idempotent, non-destructive** first-deploy bootstrap (DevOps). One entry point that generates/validates `.env.prod`, brings up the prod profile, and walks the operator to the `/setup` wizard. Safe to re-run.

### Local dev

- Plain `docker compose up` (compose.yaml + compose.override.yaml) brings up `db`, `meilisearch`, `zitadel`, `zitadel_db` only (loopback / internal — SEC-005, ADR-0028).
- `bun run dev` runs api + web natively against those; `AUTH_MODE=shim` by default.

### Docker images

- `infra/docker/api.Dockerfile` — multi-stage: Bun build → Node runtime (ADR-0025)
- `infra/docker/web.Dockerfile` — multi-stage: Bun build → Next.js standalone
- `infra/docker/migrate.Dockerfile` — one-shot Prisma migrate + seed (**FIXED**: now builds `@lazyit/shared` before the seed runs — the seed imports the permission catalog; hotfix `69fb9cf` committed directly to `dev` at the CEO's request)
- `infra/docker/zitadel-bootstrap.Dockerfile` — the zero-touch provisioning sidecar

### CI

- `.github/workflows/ci.yml`
- Triggers: push to `master`/`dev`, PRs targeting `master`/`dev`
- Jobs:
  - **verify**: typecheck (shared, api, web) → lint [non-blocking] → test API (Node/Jest) + shared (bun test) → build all
  - **docker**: build all three images (no push) — needs `verify`
- Lint is `continue-on-error: true` — **non-blocking** (pre-existing ~168 warnings; known debt)
- Node 24 set up alongside Bun for Jest (jest@30 can't run under Bun's runtime — local-node-for-jest)

---

## Domain entities (summary)

All entities are in Prisma. See `apps/api/prisma/schema.prisma` for fields.

**Append-only (no soft delete)**:
- `AssetAssignment` — ownership timeline; `releasedAt` closes an assignment
- `AssetHistory` — discrete event log (`autoincrement` id); `RESTORED` now emitted (ADR-0041)
- `AccessGrant` — access timeline; `revokedAt` closes a grant
- `ConsumableMovement` — stock ledger (`autoincrement` id)
- `ArticleVersion` — **NEW** (ADR-0042): append-only snapshot (`autoincrement` id), `@@unique([articleId, version])`, frozen `title/content/excerpt/status` per edit; FK Restrict. Genuinely exists now — corrects the old "exists in schema but not wired" note.
- `PermissionAuditLog` — **NEW** (ADR-0046): append-only record of every RolePermission matrix change (who/when/before→after).
- `ServiceAccountAuditLog` — **NEW** (ADR-0048): append-only record of ServiceAccount lifecycle (create/rotate/revoke/grant). NOTE: its own SA-actor column is deferred to a future ADR (a SA that manages another SA is currently attributed `null`).
- **Audit-actor columns on the 6 append-only tables** — **NEW** (ADR-0048): AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement, ArticleVersion, PermissionAuditLog each gained a **nullable `serviceAccountId`** alongside the existing human `actorId`, plus an **at-most-one-actor CHECK** (a row is attributed to a human XOR a SA, or neither). Human action → `actorId` set / `serviceAccountId` null; SA action → the reverse.

**Current-state join (not soft-delete, not an audit log)**:
- `ArticleLink` — **NEW** (ADR-0042): article↔asset OR application (cuid id, nullable `assetId`/`applicationId`). DB CHECK enforces exactly one target; two partial unique indexes prevent dup links; FKs `onDelete: Cascade`. Hard-deleted on removal.

**Soft-deletable (have `deletedAt`)**:
- `User` (+ `role Role @default(VIEWER)`), `Location`, `AssetCategory`, `AssetModel`, `Asset`
- `ArticleCategory`, `Article`
- `ApplicationCategory`, `Application`
- `ConsumableCategory`, `Consumable`
- `ServiceAccount` — **NEW** (ADR-0048): a lazyit-native principal (NOT a User, NOT a Zitadel machine-user); holds the hashed token + name/description + lifecycle.

**Config / join tables (RBAC v2 + SA, ADR-0046/0048)**:
- `RolePermission` — **NEW** (ADR-0046): the (role × permission) matrix; mutated via PUT `/config/permissions`; ADMIN never appears (always-full short-circuit, INV-8).
- `ServiceAccountPermission` — **NEW** (ADR-0048): direct (ServiceAccount × permission) grants; no role indirection.

**Derived (Postgres VIEW, not a table)**:
- `recent_activity` — **NEW** (ADR-0044): `UNION ALL` over asset_history + asset_assignments + access_grants + consumable_movements into `{occurredAt, actorId, entityType, entityId, action, summary}`; raw SQL in a migration (Prisma can't express a UNION view); read via typed `$queryRaw` in `DashboardService.getActivity`; re-derives soft-delete filtering in SQL.

**Enum**:
- `Role { ADMIN MEMBER VIEWER }` — **NEW** (ADR-0040), default VIEWER (ADR-0043).

**Key constraints**:
- `User.id` = uuid (ADR-0005); most others = cuid
- `AssetHistory.id`, `ConsumableMovement.id`, `ArticleVersion.id` = autoincrement (never exposed)
- `User.externalId` = nullable but **fully `@unique`** (deliberately NOT partial — the JIT upsert/link path needs a true unique key); reserved for OIDC sub
- `User.email` = `@db.Citext` (case-insensitive — ADR-0041)
- **Partial unique indexes `WHERE "deletedAt" IS NULL`** (ADR-0041, raw SQL — Prisma can't express them) free email/slug/sku/name/serial/assetTag for reuse on: User.email, AssetCategory.name, AssetModel.sku, Asset.serial+assetTag, ArticleCategory.name, Article.slug, ApplicationCategory.name, ConsumableCategory.name, Consumable.sku. Plus the older `AssetAssignment (assetId, userId) WHERE releasedAt IS NULL` and the two ArticleLink partial uniques.
- Foreign key strategies: Restrict (history-bearing FKs), SetNull (audit actor FKs), Cascade only on `ArticleLink` (the link is meaningless without its endpoints).

---

## Cross-cutting concerns

### Authorization (RBAC v2 — Roles & Permissions, ADR-0046; SA authZ ADR-0048)

- `PermissionGuard` (2nd APP_GUARD) + `@RequirePermission('<domain>:<verb>')` + `PermissionResolverService` enforce a **fine-grained permission**, resolved **from the DB** matrix; a token claim is never trusted (INV-1). `RolesGuard`/`@Roles` are **retired**.
- **3 FIXED roles, configurable permissions**: ADMIN is immutable/always-full (INV-8); MEMBER/VIEWER permissions live in `RolePermission`, seeded by `buildDefaultRolePermissions` and editable at runtime (PUT `/config/permissions`). 33-permission catalog-as-code in `@lazyit/shared`. Default role VIEWER; first-ever user ADMIN.
- **Read-authz closed**: every read GET carries `<domain>:read`; the safe-default seed pre-tightens `accessGrant:read` + `user:read` to ADMIN+MEMBER. Coarse verbs + `:delete` are grantable to MEMBER/VIEWER with a ⚠ (admin-initiated delegation, no server block).
- **Permissions never sync to the IdP** (BYOI-safe) — Zitadel mirrors identity + the 3 roles only.
- **Service Accounts** (ADR-0048): a separate `ServiceAccount` principal authenticated by a hashed `lzit_sa_…` token (SA-token branch in JwtAuthGuard), with **direct** catalog permission grants (`ServiceAccountPermission`) — never a Role, never ADMIN; fail-closed.
- Last-admin (409) and no-self-role-change (403) service guards remain; `GET /users/me` exposes the caller's role, `GET /config/my-permissions` exposes the caller's effective permission set to the UI.

### Soft-delete & restore (ADR-0032/0041)

- Prisma `$extends` client extension in `prisma/soft-delete.extension.ts`
- Filters `deletedAt: null` on `findMany`, `findFirst`, `findUnique` automatically; `includeSoftDeleted` escape hatch for restore
- **Restore** (ADR-0041): ADMIN-gated `POST /<resource>/:id/restore` clears `deletedAt` for User, Asset, Article, Application, Location, Consumable, AssetModel + the four categories. Idempotent; can 409 if a live row took the freed value. Asset restore emits `RESTORED`; Article restore is author-only; User restore does NOT re-grant/re-assign.
- Append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement, ArticleVersion) do NOT soft-delete — they use `releasedAt`/`revokedAt` lifecycle markers

### Logging (ADR-0031)

- Pino + nestjs-pino; pretty in dev, JSON in prod
- `X-Request-Id` generated per request, propagated to response headers, exposed via CORS
- Request bodies NOT logged (security decision)
- Frontend reads `X-Request-Id` from responses and shows it in error surfaces

### Validation (ADR-0018)

- `nestjs-zod` + `createZodDto` + global `ZodValidationPipe`
- All endpoints typed via shared zod schemas
- `z.strictObject` everywhere: unknown keys rejected

### Search (ADR-0035)

- Meilisearch `v1.12.3` — **now in both dev and prod compose** (internal-only in prod)
- Indexed: assets, articles, users, locations, applications (one index each)
- **Article content is now indexed** (ADR-0042) — runbook bodies are findable, not just title/excerpt. Only PUBLISHED articles are ever indexed (draft privacy intact).
- Sync: authoritative reindex/swap + fire-and-forget per service (fail-soft reads — Round 1 search hardening)
- Endpoint: `GET /search?q=&entities=&limit=20`
- Bootstrap: `bun run reindex:all` (re-run after deploy to backfill `content`)

### Actor resolution (now @CurrentUser, ADR-0038)

- Auth source is the global `JwtAuthGuard` → `request.user`; the `@CurrentUser()` decorator extracts it. The X-User-Id shim survives only as `AUTH_MODE=shim` (dev/tests, prod-guarded).
- `ActorService` (CommonModule, global) is now trivial: `resolve(user?) → user?.id`. Used by AssetAssignments, AccessGrants, Articles (authorId), AssetHistory, Consumables.

---

## Known debt (refreshed 2026-06-03)

RBAC is now **v2** (ADR-0046 — fixed roles + fully-configurable permissions) and **read-authorization is
CLOSED** (the former headline Medium): every read GET is `<domain>:read`-gated and the safe-default seed
pre-tightens `accessGrant:read`/`user:read` to ADMIN+MEMBER. **Service Accounts** shipped (ADR-0048).
**SEC-009 (Swagger public in prod) and SEC-010 (XFF-spoof setup rate-limit) are CLOSED.** The remaining
items are the **Round-2 backlog** the CEO parked while the epics shipped.

| Item | Severity | Why deferred | Revisit trigger |
|------|----------|-------------|----------------|
| **ServiceAccountAuditLog SA-actor column** — a SA that manages another SA is attributed `null` (no `serviceAccountId` on this log yet) | Low | Carved out of ADR-0048 for its own future ADR | When SA-on-SA attribution is needed |
| **Revoke/release races** — AccessGrant revoke + AssetAssignment release are not fully race-guarded | Low–Medium | Round-2 backlog | When concurrency observed or before prod |
| **Server-side filters still client-side** — applications category/criticality, users status, locations type filters run CLIENT-side over the loaded page (backend has no such param); asset Model deep-link is by Category only (no server model filter) | Low | UX cycle migrated all 6 main lists to `Page<T>` + server `q`/sort (#104); these category-ish filters deferred | When a list grows past one page often enough to need server filtering |
| **DB indexes** — missing partial/sort indexes + `pg_trgm` for search-ish lookups | Low | Round-2 backlog; MVP scale tolerable | When query latency shows up |
| **Integration-test tier** — only unit (Jest/`bun test`); no API integration suite | Low | ADR-0012 deferred | When critical flows stabilize |
| **CSV import/export** — not built | Low | Round-2 backlog (product feature) | When operators ask |
| **Warranty / expiry read filters** — no list filters for expiring assets/warranties | Low | Round-2 backlog | When the inventory grows |
| SEC-002: .docx decompression bomb | Medium | Deferred to BullMQ worker | When async workers are built |
| SEC-003: stored XSS in KB markdown — render-time `rehype-sanitize` **shipped on the web**; the finding file is still `open` (no write-time sanitize; SEC doc not yet moved to `closed/`) | Low | Render-time defense is the chosen posture (ADR-0029) | Sentinel close-out: verify + move SEC-003 |
| Async **scheduler** (cron/queue for expiry, reminders, periodic role-sync) | Deferred | CEO deferred; no BullMQ yet | When a recurring job is actually needed |
| Lint warnings, CI non-blocking | Low | Pre-existing; `continue-on-error: true` | Cleanup sprint |
| `noUncheckedIndexedAccess` not enforced in shared build | Low | Editor-only strictness | When shared tsconfig.build.json is tightened |
| No E2E tests | Low | ADR-0012 deferred | When critical flows stabilize |
| BYOI write-back is read-only (no SCIM/webhook) | Low | CEO-approved for v1 (ADR-0043 Fork #5) | When a BYOI customer needs write-back |
| Existing-user → Zitadel bulk role-sync NOT built | Low | dev-only; `down -v` for a clean slate (ADR-0043 Fork #6) | **Before any production deployment** |

---

## Pending major decisions

| Decision | Status | Gate |
|----------|--------|------|
| **IdP / auth architecture** | ✅ **DECIDED — Option B** (ADR-0043): Zitadel = source of truth for identity+roles+tokens, write-back via Management API, in-app setup wizard, DEFAULT VIEWER, DB-first authZ, BYOI graceful | — |
| **IdP provider / database / BYOI surface** | ✅ Decided (ADR-0037/0043): Zitadel bundled (own Postgres) + `IdentityProvider` adapter keyed on `IDENTITY_PROVIDER_TYPE`; BYOI via env (read-only role mgmt) | — |
| **Frontend pagination + list contract** | ✅ Decided + done (ADR-0030 + amendment §6/§7): `Page<T>` + server `q`/sort/`dir`/`deleted` live on all 6 main lists + /articles + /access-grants + /dashboard/activity; full pagination UI + URL list-state shipped (#104/#110/#114) | — |
| **Authorization model (RBAC v2 — Roles & Permissions)** | ✅ **DECIDED + done** (ADR-0046): 3 FIXED roles + fully-configurable per-role permissions (catalog-as-code, `RolePermission`, `@RequirePermission`); `@Roles` retired; **read-authz CLOSED** via the safe-default seed | — |
| **Service Accounts (non-human principals)** | ✅ **DECIDED + done** (ADR-0048): separate `ServiceAccount` + native hashed `lzit_sa_…` token, direct catalog grants, fail-closed, SA-actor audit columns | — |
| Async workers: BullMQ + Redis (+ scheduler) | ⬛ Not decided | **STILL the gate** for SEC-002, backups-from-frontend, and the Application workflow engine (P4); any recurring job unblocks on this |
| CD / image publishing (GHCR + deploy flow) | ⬛ Not decided | Deferred in ADR-0027 |
| E2E / integration testing tooling | ⬛ Not decided | Deferred in ADR-0012 |
| Settings backend (general app settings store) | ⬛ Not decided | `/config` covers first-run only; the new `/settings` web area is ADMIN UI over existing endpoints (taxonomies, asset-models, roles overview, config-status) — there is still no general settings store |
| BYOI write-back interface (SCIM/webhook) + bidirectional role sync | ⬛ Deferred to a future ADR | ADR-0043 Fork #5 |

---

## Current state (2026-06-03)

- `dev` is **post-RBAC-v2 + Service-Accounts epic** — ADR-0046 (Roles & Permissions v2), ADR-0047 (`start.sh`), ADR-0048 (Service Accounts), plus SEC-009/SEC-010 closed and a Clone feature, all merged. (PRs #122 #123 #126 #127 #129 #131 #134 #135 #138 #139 #142 #143 + the `69fb9cf` migrate.Dockerfile hotfix committed directly to `dev` at the CEO's request.)
- `dev` is also **post-auth-epic** — ADR-0043 (Zitadel source-of-truth, Option B) delivered and **validated live end-to-end on 2026-06-01** (zero-touch first boot + in-app `/setup` wizard creating + mirroring the first ADMIN). Phase-4 hardening (#92–#96) merged.
- Three rounds landed on `dev` since 2026-05-26:
  - **Round 1 (PRs #61–72)**: dashboard backend, Health + `@Public()`, pagination ACTUALLY implemented (ADR-0030), user-offboarding integrity, auth hardening (RS256 pin, isActive reject, JIT no-resurrect, shim prod-guard, fail-loud boot-config), consumable stock-race + int4 guard, search hardening (content indexed), frontend UX foundation (#65: palette/mobile-nav/rehype-sanitize/error-boundaries/keepPreviousData), DR/infra hardening (#66: digest pins, log rotation, mem_limit, backup sidecar), doc drift fixed (#64).
  - **Auth epic (ADR-0040–0043)**: RBAC, soft-delete reuse + restore (ADR-0041), KB versioning + linking (ADR-0042), Zitadel source-of-truth + write-back + wizard (ADR-0043).
  - **Round 3 + extras (#81–84, #86)**: softened palette, role-management UI in Users, consumable quick-adjust, asset custom-fields editor, dashboard recent-activity VIEW (ADR-0044).
- **UX northstar cycle (PRs #100–#115) merged to `dev` 2026-06-01** — Fase 1+2 + four new surfaces (settings / KB runbooks UI / restore / bulk). Backend: list contracts extended with `sort`/`dir` (ADR-0030 §6) + `q` + `deleted=only` (§7) on the 5 lists, batch endpoints, KB reverse endpoints, consumable soft-delete leak fixed (#114). Frontend: shared chrome (PageHeader/Breadcrumb/SearchInput), StatusBadge/tokens (ADR-0011 amd 3), DetailPanel, RBAC-gated writes (`useCanWrite`), URL-driven list state, real pagination UI, bulk/restore + archived toggle, `/settings` admin area, KB runbooks panels, **heroicons-only (ADR-0045, lucide dropped)**. CEO authorized the CTO to merge these PRs to `dev`.
- **RBAC v2 + Service-Accounts epic (2026-06-03)** — delivered via the validated pattern: a **read-only design/audit workflow → CEO forks → serialized implementation waves**, each wave gated by an adversarial multi-agent review (correctness + sentinel, with verification) before merge. Backend: PermissionResolverService + `@RequirePermission` (41 read GETs `<domain>:read`-annotated, 63 write gates migrated, `@Roles` retired), `/config/permissions` + `/config/my-permissions`, the new `/service-accounts` module, the SA-token branch in JwtAuthGuard, 5 new entities + SA-actor audit columns + CHECK. Shared: the 33-permission catalog + matrix/preset/clone helpers + SA schemas. Frontend: `/settings/roles/permissions` (role-first editor), `/settings/service-accounts` (one-time secret reveal), the `can()` infra with ALL gating migrated `isAdmin`→`can()` (`useCanWrite` retired), Clone. Security: SEC-009 + SEC-010 closed; read-authz debt closed.
- Infra consolidated to a single `compose.yaml` + `compose.override.yaml` + `prod` profile + `infra/docker-compose.prod.yaml`; old `docker-compose.yml` / `infra/docker-compose.prod.yml` gone. Zero-touch Zitadel sidecars + `zitadel_secrets` volume. **`start.sh`** first-deploy bootstrap added (ADR-0047).
- ADR count: 48 (0001–0048). `docs/06-security/INVARIANTS.md` records the 7 auth non-negotiables + INV-8 (ADMIN immutable/full) + INV-SA-1..4.
- Next candidates: **async workers (BullMQ + Redis)** — now the explicit gate for backups-from-frontend + the Application workflow engine (P4); the residual UX Phase-3 polish + the not-yet-wired access-grants bulk-revoke UI + server-side filters for the client-side filter cases; the Round-2 backlog (revoke/release races, DB indexes/pg_trgm, integration tests, CSV import/export, warranty/expiry filters); the ServiceAccountAuditLog SA-actor column (own future ADR).

---

## Update protocol

Update this file when:
- A new module is added
- An entity is added, renamed, or restructured
- A cross-cutting concern is introduced
- A major architectural decision lands
- Known debt is added or resolved
- A pending decision moves to decided
