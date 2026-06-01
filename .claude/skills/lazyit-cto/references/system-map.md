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
> **Docs**: `docs/` (Obsidian vault — 44 ADRs (0001–0044) as of 2026-06-01) + `docs/06-security/INVARIANTS.md` (the 7 auth non-negotiables)
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
| AuthModule (`@Global`) | `auth/` | JwtAuthGuard + RolesGuard (two ordered APP_GUARDs), @CurrentUser()/@Roles()/@Public() decorators, `IDENTITY_PROVIDER` (IdP write-back seam) | stable — auth epic delivered (ADR-0043) |
| CommonModule | `common/` | ActorService, AllExceptionsFilter, PrismaExceptionFilter, ParseUuidQuery | stable |
| PrismaModule | `prisma/` | PrismaService + soft-delete extension | stable |
| SearchModule | `search/` | SearchService (Meilisearch), GET /search | stable |
| HealthModule | `health/` | `@Public()` GET /health/live + /health/ready (hand-rolled, no terminus) | stable |
| ConfigModule | `config/` | `@Public()` GET /config/status + idempotent CSRF+rate-limited POST /config/setup (first-ADMIN bootstrap, ADR-0043 §4) | stable |
| DashboardModule | `dashboard/` | GET /dashboard/summary (cross-pillar counts) + GET /dashboard/activity (recent_activity VIEW, ADR-0044) — read-only, no schema | stable |
| AssetHistoryModule | `asset-history/` | AssetHistory (read-only, no controller) | stable |
| UsersModule | `users/` | User + role management (GET /users/me, set-role, last-admin/self guards) + ADMIN-gated CRUD + IdP write-back | stable |
| LocationsModule | `locations/` | Location | stable |
| AssetCategoriesModule | `asset-categories/` | AssetCategory | stable |
| AssetModelsModule | `asset-models/` | AssetModel | stable |
| AssetsModule | `assets/` | Asset (specs jsonb custom fields) + restore | stable |
| AssetAssignmentsModule | `asset-assignments/` | AssetAssignment | stable |
| ArticleCategoriesModule | `article-categories/` | ArticleCategory | stable |
| ArticlesModule | `articles/` | Article + append-only ArticleVersion + ArticleLink (article↔asset/app), .docx import, content indexed (ADR-0042) | stable |
| ApplicationCategoriesModule | `application-categories/` | ApplicationCategory | stable |
| ApplicationsModule | `applications/` | Application | stable |
| AccessGrantsModule | `access-grants/` | AccessGrant (ADMIN-gated writes) | stable |
| ConsumableCategoriesModule | `consumable-categories/` | ConsumableCategory | stable |
| ConsumablesModule | `consumables/` | Consumable + ConsumableMovement (int4-guarded, stock-race-safe) | stable |
| LoggingModule (via LoggerModule.forRoot) | `logging/` | Pino config (ADR-0031) | stable |

Module registration order is load-bearing in two places: `LoggerModule.forRoot(...)` is imported first (wraps every route), and inside AuthModule the two `APP_GUARD`s run in registration order — `JwtAuthGuard` (sets `request.user`) **then** `RolesGuard` (enforces `@Roles()`).

### Cross-cutting middleware and global services

- **ZodValidationPipe** (global, APP_PIPE) — validates every `@Body` typed with `createZodDto`
- **AllExceptionsFilter** (global, APP_FILTER) — logs >=500 errors with stack; delegates Prisma errors to PrismaExceptionFilter
- **PrismaExceptionFilter** — maps P2002→409, P2003/P2023→400, P2025→404
- **JwtAuthGuard** (from AuthModule, global APP_GUARD #1, **authentication**) — validates OIDC Bearer JWT via JWKS (RS256-pinned) or reads X-User-Id in `AUTH_MODE=shim` (prod-guarded off). Resolves `request.user` (User entity) from the DB by `externalId`/id; JIT-provisions + email-account-links on first OIDC login (ADR-0038/0043). Honors `@Public()`
- **RolesGuard** (from AuthModule, global APP_GUARD #2, **authorization**, ADR-0040) — runs after JwtAuthGuard; reads `@Roles(...)` metadata and enforces against `request.user.role` **from the DB** (403 on insufficient/missing actor). Unannotated route → any authenticated user; `@Public()` → skip. **Authorization is DB-first**: a token role claim is NEVER an authZ source (INV-1)
- **@CurrentUser()** / **@Roles()** / **@Public()** (decorators) — actor extraction, role-gating, and auth bypass respectively
- **IdentityProvider** (`auth/identity/`, DI token `IDENTITY_PROVIDER`, ADR-0043) — the IdP write-back seam. An `IdentityProvider` interface + `GenericOidcIdentityProvider` (BYOI; management methods no-op + warn) + `ZitadelIdentityProvider`, selected by a factory keyed on `IDENTITY_PROVIDER_TYPE` (`zitadel` | `generic-oidc`, default `zitadel`). `ZitadelManagementService` does the real Management-API write-back (see Auth section)
- **ActorService** (from CommonModule, exported globally) — now trivial: `resolve(user?: User) → user?.id`. DB lookup removed (guard handles it). Used by: Assets, AssetAssignments, AccessGrants, Articles, Consumables
- **Pino / nestjs-pino** — structured logging; X-Request-Id propagated end-to-end
- **Soft-delete Prisma extension** — automatically adds `deletedAt: null` to every `findMany`/`findFirst`/`findUnique` query; `includeSoftDeleted` escape hatch used by restore endpoints (ADR-0041)
- **CORS** — origin from `WEB_ORIGIN` env (default `http://localhost:3000`); `credentials: true`; exposes `X-Request-Id`
- **Swagger/OpenAPI** — `/api/docs` (UI) + `/api/docs-json` (raw JSON). Unauthenticated (ADR-0018, DEF-003)
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

**Authorization (AuthZ) — RBAC, DB-first (ADR-0040, INV-1)**
- `enum Role { ADMIN MEMBER VIEWER }` on `User`, **`@default(VIEWER)`** (flipped from MEMBER by ADR-0043 — uniform least-privilege for app-created AND non-first JIT users). The **first user ever on an empty DB stays ADMIN** (seed or first JIT login) so an install is never un-administrable.
- `RolesGuard` + `@Roles(...)`: ADMIN-gated = AccessGrant writes, Users administration, all destructive DELETEs, and restore endpoints; ordinary writes = `@Roles('ADMIN','MEMBER')` (VIEWER is read-only everywhere); all `GET`s unannotated. **The token role claim is never an authZ source** — every privilege decision re-reads `User.role` from the DB.
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
- **Palette (Round 1 #65 + Round 3 #81)**: softened neutral — warm bone (light) + dark warm gray (dark), keeping the indigo brand accent. KB markdown rendered via `rehype-sanitize` (closes SEC-003 render-time XSS). Mobile nav added.
- TanStack Query for data layer (ADR-0020); `keepPreviousData` on paginated lists
- react-hook-form + zodResolver for forms
- next-themes for dark mode; Sonner for toasts
- **heroicons only** in app code (lucide-react only inside `components/ui/*` vendored shadcn)

### Route groups

- `(app)` — authenticated app (Auth.js session; sidebar layout in `app/(app)/layout.tsx`)
- `(auth)` — login flow (functional; redirects to IdP)
- `(marketing)` — landing / public surface (minimal)
- `app/setup` — full-screen first-run wizard (top-level, outside `(app)`; ADR-0043)
- `app/api/auth/[...nextauth]` — Auth.js route handler

### Live screens (functional as of 2026-06-01)

| Route | Screen | Notes |
|-------|--------|-------|
| `/setup` | First-run wizard | 4-step: welcome/integration choice → optional Zitadel config → create first ADMIN → done. Self-locks once an ADMIN exists (ADR-0043) |
| `/dashboard` | Dashboard | **Wired** to GET /dashboard/summary (counts) + a Recent-activity panel (infinite query over GET /dashboard/activity, ADR-0044) |
| `/assets` | Asset list | ResourceTable + search/filter + delete (paginated) |
| `/assets/new` | Create asset | Full form with inline creatable fields + custom-fields editor (specs jsonb) |
| `/assets/[id]` | Asset detail | Assignments + AssetHistory timeline |
| `/assets/[id]/edit` | Edit asset | Same form |
| `/locations` | Location list | Inline create/edit dialog |
| `/locations/[id]` | Location detail | Detail view |
| `/users` | User list | Inline create/edit dialog + per-row role (UserRoleSelect/Badge) |
| `/users/[id]` | User detail | Profile + role management (ADMIN-only Select, confirmation, 409/403 surfaced) |
| `/kb` | KB article list | Draft/published, author visibility |
| `/kb/new` | Create article | Markdown editor + .docx import |
| `/kb/[slug]` | Article detail | Markdown rendered, `rehype-sanitize` (SEC-003 closed) |
| `/kb/[slug]/edit` | Edit article | Markdown editor |
| `/applications` | Application list | With grant access inline |
| `/applications/new` | Create application | Full form |
| `/applications/[id]` | Application detail | Grant list + revoke |
| `/applications/[id]/edit` | Edit application | |
| `/consumables` | Consumable list | Stock badges + one-click +1/-1 quick-adjust |
| `/consumables/new` | Create consumable | |
| `/consumables/[id]` | Consumable detail | Movement ledger + quick-adjust |
| `/consumables/[id]/edit` | Edit consumable | |
| `/login` | Login page | Functional — redirects to IdP |

### Shared components and primitives

| Component | Location | Purpose |
|-----------|----------|---------|
| `ResourceTable` | `components/resource-table.tsx` | Reusable table with search/sort/delete |
| `DeleteConfirmDialog` | `components/delete-confirm-dialog.tsx` | Reusable soft-delete confirmation |
| `GlobalSearch` | `components/global-search.tsx` | Cmd+K palette, calls GET /search |
| `MarkdownEditor` | `components/markdown-editor.tsx` | KB editing surface |
| `MarkdownView` | `components/markdown-view.tsx` | KB rendering, `rehype-sanitize` allow-list (SEC-003 closed) |
| `CreatableField` | `components/creatable-field.tsx` | Inline "New" beside selects → dialog → auto-select |
| `CreateCategoryDialog` | `components/create-category-dialog.tsx` | Reusable category inline create |
| `CreateAssetModelDialog` | `components/create-asset-model-dialog.tsx` | Reusable model inline create |
| `UserAvatar` | `components/user-avatar.tsx` | Avatar from user initials |
| `UserMenu` | `components/user-menu.tsx` | Topbar user menu |
| `RequestIdNote` | `components/request-id-note.tsx` | Copy-to-clipboard request ID in error surfaces |
| `ThemeToggle` | `components/theme-toggle.tsx` | Dark/light mode |
| `SidebarNav` | `components/sidebar-nav.tsx` | App navigation sidebar (+ mobile nav) |
| `UserRoleSelect` / `UserRoleBadge` | `app/(app)/users/_components/` | Role read-only badge vs ADMIN-only Select (reads `GET /users/me`) |
| `CustomFieldsEditor` | `app/(app)/assets/_components/custom-fields-editor.tsx` | Edits the asset `specs` jsonb |
| `QuickAdjustButtons` | `app/(app)/consumables/_components/quick-adjust-buttons.tsx` | One-click +1/-1 stock movement |
| `RecentActivityPanel` | `app/(app)/dashboard/_components/recent-activity-panel.tsx` | Infinite-query feed over GET /dashboard/activity |
| `SetupWizard` (+ steps) | `app/setup/_components/` | First-run wizard (welcome → configure → create-admin → done) |

### Error UX (delivered sub-issue #30, 2026-05-26) + error boundaries (Round 1 #65)

- `app/(app)/error.tsx` — Next.js error boundary: shows request ID from ApiError, "Try again" button
- `RequestIdNote` — inline request ID with copy-to-clipboard (used in error boundary and list error states)
- `lib/api/notify-error.ts` — inline mutation errors via Sonner toast
- Round 1 (#65) added route-level error boundaries leveraging `x-request-id` end-to-end

### Data layer convention (ADR-0020)

- `lib/api/endpoints/*.ts` — pure fetch wrappers (one file per entity); paginated endpoints unwrap the `Page<T>` envelope (`.items`, ADR-0030)
- `lib/api/hooks/*.ts` — TanStack Query hooks (incl. `useUserMe`, `useConfigStatus`, `useDashboardActivity` infinite query)
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
- **pagination** (`PageQuerySchema`, `Page<T>` via `pageSchema()`, `offsetOf()`/`pageOf()` helpers — ADR-0030, now implemented)
- **config** (setup/status contract — ADR-0043)
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

### Local dev

- Plain `docker compose up` (compose.yaml + compose.override.yaml) brings up `db`, `meilisearch`, `zitadel`, `zitadel_db` only (loopback / internal — SEC-005, ADR-0028).
- `bun run dev` runs api + web natively against those; `AUTH_MODE=shim` by default.

### Docker images

- `infra/docker/api.Dockerfile` — multi-stage: Bun build → Node runtime (ADR-0025)
- `infra/docker/web.Dockerfile` — multi-stage: Bun build → Next.js standalone
- `infra/docker/migrate.Dockerfile` — one-shot Prisma migrate + seed
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

**Current-state join (not soft-delete, not an audit log)**:
- `ArticleLink` — **NEW** (ADR-0042): article↔asset OR application (cuid id, nullable `assetId`/`applicationId`). DB CHECK enforces exactly one target; two partial unique indexes prevent dup links; FKs `onDelete: Cascade`. Hard-deleted on removal.

**Soft-deletable (have `deletedAt`)**:
- `User` (+ `role Role @default(VIEWER)`), `Location`, `AssetCategory`, `AssetModel`, `Asset`
- `ArticleCategory`, `Article`
- `ApplicationCategory`, `Application`
- `ConsumableCategory`, `Consumable`

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

### Authorization (RBAC, ADR-0040/0043)

- `RolesGuard` (2nd APP_GUARD) + `@Roles(...)` enforce `User.role` (ADMIN/MEMBER/VIEWER) **from the DB**; a token role claim is never trusted (INV-1). Default VIEWER; first-ever user ADMIN.
- ADMIN-gated: AccessGrant writes, all Users administration, all destructive DELETEs, all restore endpoints. Ordinary writes `@Roles('ADMIN','MEMBER')`; GETs open to any authenticated user.
- Last-admin (409) and no-self-role-change (403) service guards; `GET /users/me` exposes the caller's role to the UI.

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

## Known debt (refreshed 2026-06-01)

RBAC now **exists** (ADR-0040 — closes the May review's #1 finding). The headline remaining gap is
**read-authorization** (everything readable is readable by any authenticated user, including VIEWER) —
the next AuthZ wave. The rest is the **Round-2 backlog** the CEO parked while the auth epic shipped.

| Item | Severity | Why deferred | Revisit trigger |
|------|----------|-------------|----------------|
| **Read-authorization** — all GETs open to any authenticated user (incl. VIEWER); no per-resource read scoping | Medium | RBAC v1 gated writes only (ADR-0040); read scoping is the next wave | When a tenant/visibility need appears |
| **Revoke/release races** — AccessGrant revoke + AssetAssignment release are not fully race-guarded | Low–Medium | Round-2 backlog | When concurrency observed or before prod |
| **Paginate the still-unpaginated list endpoints** — only /assets, /articles, /access-grants (+ /dashboard/activity) use `Page<T>`; the rest still `findAll` (SEC-007 still `open`) | Low | ADR-0030 done for the heavy lists; the rest deferred | When any other list grows |
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
| **Frontend pagination implementation** | ✅ Decided + partly done (ADR-0030): `Page<T>` live on /assets,/articles,/access-grants,/dashboard/activity; remaining lists pending | When other lists grow |
| **Read-authorization model** | ⬛ Not decided | Next AuthZ wave (see debt) |
| Async workers: BullMQ + Redis (+ scheduler) | ⬛ Not decided | SEC-002 + any recurring job unblocks on this |
| CD / image publishing (GHCR + deploy flow) | ⬛ Not decided | Deferred in ADR-0027 |
| E2E / integration testing tooling | ⬛ Not decided | Deferred in ADR-0012 |
| Settings backend (general app settings) | ⬛ Not decided | `/config` covers first-run only; no general settings store yet |
| BYOI write-back interface (SCIM/webhook) + bidirectional role sync | ⬛ Deferred to a future ADR | ADR-0043 Fork #5 |

---

## Current state (2026-06-01)

- `dev` is **post-auth-epic** — ADR-0043 (Zitadel source-of-truth, Option B) delivered and **validated live end-to-end on 2026-06-01** (zero-touch first boot + in-app `/setup` wizard creating + mirroring the first ADMIN). Phase-4 hardening (#92–#96) merged.
- Three rounds landed on `dev` since 2026-05-26:
  - **Round 1 (PRs #61–72)**: dashboard backend, Health + `@Public()`, pagination ACTUALLY implemented (ADR-0030), user-offboarding integrity, auth hardening (RS256 pin, isActive reject, JIT no-resurrect, shim prod-guard, fail-loud boot-config), consumable stock-race + int4 guard, search hardening (content indexed), frontend UX foundation (#65: palette/mobile-nav/rehype-sanitize/error-boundaries/keepPreviousData), DR/infra hardening (#66: digest pins, log rotation, mem_limit, backup sidecar), doc drift fixed (#64).
  - **Auth epic (ADR-0040–0043)**: RBAC, soft-delete reuse + restore (ADR-0041), KB versioning + linking (ADR-0042), Zitadel source-of-truth + write-back + wizard (ADR-0043).
  - **Round 3 + extras (#81–84, #86)**: softened palette, role-management UI in Users, consumable quick-adjust, asset custom-fields editor, dashboard recent-activity VIEW (ADR-0044).
- Infra consolidated to a single `compose.yaml` + `compose.override.yaml` + `prod` profile + `infra/docker-compose.prod.yaml`; old `docker-compose.yml` / `infra/docker-compose.prod.yml` gone. Zero-touch Zitadel sidecars + `zitadel_secrets` volume.
- ADR count: 44 (0001–0044). `docs/06-security/INVARIANTS.md` records the 7 auth non-negotiables.
- Next candidates: read-authorization wave, the Round-2 backlog (revoke/release races, paginate remaining lists, DB indexes/pg_trgm, integration tests, CSV import/export, warranty/expiry filters), KB version/link UI; scheduler still deferred.

---

## Update protocol

Update this file when:
- A new module is added
- An entity is added, renamed, or restructured
- A cross-cutting concern is introduced
- A major architectural decision lands
- Known debt is added or resolved
- A pending decision moves to decided
