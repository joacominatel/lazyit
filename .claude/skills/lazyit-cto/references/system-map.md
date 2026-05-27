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
> **Infra**: `infra/` (Docker prod compose, Caddy, env templates, Dockerfiles)
> **Docs**: `docs/` (Obsidian vault — 36 ADRs as of 2026-05-26)
> **Skills**: `.claude/skills/` (cto, navigator, devops, sentinel, remediator)

Ports: Web → `:3000` · API → `:3001` · Postgres → `:5432` (loopback) · Meilisearch → `:7700` (loopback).

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
| AuthModule | `auth/` | JwtAuthGuard (global APP_GUARD), @CurrentUser() decorator | stable — Phase 2 complete |
| CommonModule | `common/` | ActorService, AllExceptionsFilter, PrismaExceptionFilter, ParseUuidQuery | stable |
| PrismaModule | `prisma/` | PrismaService + soft-delete extension | stable |
| SearchModule | `search/` | SearchService (Meilisearch), GET /search | stable |
| AssetHistoryModule | `asset-history/` | AssetHistory (read-only, no controller) | stable |
| UsersModule | `users/` | User | stable |
| LocationsModule | `locations/` | Location | stable |
| AssetCategoriesModule | `asset-categories/` | AssetCategory | stable |
| AssetModelsModule | `asset-models/` | AssetModel | stable |
| AssetsModule | `assets/` | Asset | stable |
| AssetAssignmentsModule | `asset-assignments/` | AssetAssignment | stable |
| ArticleCategoriesModule | `article-categories/` | ArticleCategory | stable |
| ArticlesModule | `articles/` | Article + ArticleVersion (via service), .docx import | stable |
| ApplicationCategoriesModule | `application-categories/` | ApplicationCategory | stable |
| ApplicationsModule | `applications/` | Application | stable |
| AccessGrantsModule | `access-grants/` | AccessGrant | stable |
| ConsumableCategoriesModule | `consumable-categories/` | ConsumableCategory | stable |
| ConsumablesModule | `consumables/` | Consumable + ConsumableMovement | stable |
| LoggingModule (via LoggerModule.forRoot) | `logging/` | Pino config (ADR-0031) | stable |

### Cross-cutting middleware and global services

- **ZodValidationPipe** (global, APP_PIPE) — validates every `@Body` typed with `createZodDto`
- **AllExceptionsFilter** (global, APP_FILTER) — logs >=500 errors with stack; delegates Prisma errors to PrismaExceptionFilter
- **PrismaExceptionFilter** — maps P2002→409, P2003/P2023→400, P2025→404
- **JwtAuthGuard** (from AuthModule, global APP_GUARD) — validates OIDC Bearer JWT via JWKS or reads X-User-Id in `AUTH_MODE=shim`. Sets `request.user` (User entity). JIT-provisions User on first OIDC login (ADR-0038)
- **@CurrentUser()** (param decorator) — extracts `User | undefined` from `request.user`; used by all actor-tracked controllers
- **ActorService** (from CommonModule, exported globally) — now trivial: `resolve(user?: User) → user?.id`. DB lookup removed (guard handles it). Used by: Assets, AssetAssignments, AccessGrants, Articles, Consumables
- **Pino / nestjs-pino** — structured logging; X-Request-Id propagated end-to-end
- **Soft-delete Prisma extension** — automatically adds `deletedAt: null` to every `findMany`/`findFirst`/`findUnique` query
- **CORS** — origin from `WEB_ORIGIN` env (default `http://localhost:3000`); `credentials: true`; exposes `X-Request-Id`
- **Swagger/OpenAPI** — `/api/docs` (UI) + `/api/docs-json` (raw JSON). Unauthenticated (ADR-0018, DEF-003)
- **SearchService** — exported from SearchModule; injected by Assets, Articles, Users, Locations, Applications for fire-and-forget Meili sync. No-ops if `MEILI_HOST` is unset

### Database

- PostgreSQL `18-alpine` via Prisma `7.8.0` with `@prisma/adapter-pg`
- Schema at `apps/api/prisma/schema.prisma`
- Migrations at `apps/api/prisma/migrations/`
- Seed script at `apps/api/prisma/seed.ts`
- Generated client at `apps/api/generated/prisma` (gitignored; generated in CI)

### Auth status

- **Phase 2 complete** (2026-05-27). `JwtAuthGuard` is global. All endpoints protected.
- `AUTH_MODE=shim` (default in `apps/api/.env.example`) → reads `X-User-Id` header; preserves dev/test behavior; no 401 on missing header
- OIDC mode (production) → validates Bearer JWT via JWKS from `OIDC_ISSUER/.well-known/jwks.json` using `jose`; JIT-provisions User on first login; 401 on missing/invalid token
- `User.externalId` — written on first OIDC login (`sub` claim). Nullable+unique in schema (ADR-0016). `CreateUserSchema` rejects it from request body (SEC-006 closed)
- All 5 actor-tracked controllers migrated to `@CurrentUser()`: assets, asset-assignments, access-grants, consumables, articles
- New env vars: `AUTH_MODE`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` (apps/api/.env.example)
- **Phase 3 pending**: frontend login flow (Auth.js v5 or equivalent), Bearer token injection in API client, `UserSwitcher`/`acting-user.ts` removal
- Login placeholder at `apps/web/app/(auth)/login/page.tsx` — still non-functional (Phase 3)

---

## Frontend (`apps/web`)

### Framework and conventions

- Next.js `16.2.6` (App Router) + React `19.2.4`
- Tailwind v4 + shadcn/ui (preset `radix-nova`, base `neutral`)
- TanStack Query for data layer (ADR-0020)
- react-hook-form + zodResolver for forms
- next-themes for dark mode; Sonner for toasts
- **heroicons only** in app code (lucide-react only inside `components/ui/*` vendored shadcn)

### Route groups

- `(app)` — authenticated app (currently shimmed; sidebar layout in `app/(app)/layout.tsx`)
- `(auth)` — login flow skeleton (non-functional placeholder)
- `(marketing)` — landing / public surface (minimal)

### Live screens (all functional as of 2026-05-26)

| Route | Screen | Notes |
|-------|--------|-------|
| `/dashboard` | Dashboard | Placeholder (metrics TBD) |
| `/assets` | Asset list | ResourceTable + search/filter + delete |
| `/assets/new` | Create asset | Full form with inline creatable fields |
| `/assets/[id]` | Asset detail | Assignments + AssetHistory timeline |
| `/assets/[id]/edit` | Edit asset | Same form |
| `/locations` | Location list | Inline create/edit dialog |
| `/users` | User list | Inline create/edit dialog |
| `/kb` | KB article list | Draft/published, author visibility |
| `/kb/new` | Create article | Markdown editor + .docx import |
| `/kb/[slug]` | Article detail | Markdown rendered; DOMPurify deferred (SEC-003) |
| `/kb/[slug]/edit` | Edit article | Markdown editor |
| `/applications` | Application list | With grant access inline |
| `/applications/new` | Create application | Full form |
| `/applications/[id]` | Application detail | Grant list + revoke |
| `/applications/[id]/edit` | Edit application | |
| `/consumables` | Consumable list | Stock badges |
| `/consumables/new` | Create consumable | |
| `/consumables/[id]` | Consumable detail | Movement ledger |
| `/consumables/[id]/edit` | Edit consumable | |
| `/login` | Login page | Placeholder only (non-functional) |

### Shared components and primitives

| Component | Location | Purpose |
|-----------|----------|---------|
| `ResourceTable` | `components/resource-table.tsx` | Reusable table with search/sort/delete |
| `DeleteConfirmDialog` | `components/delete-confirm-dialog.tsx` | Reusable soft-delete confirmation |
| `GlobalSearch` | `components/global-search.tsx` | Cmd+K palette, calls GET /search |
| `MarkdownEditor` | `components/markdown-editor.tsx` | KB editing surface |
| `MarkdownView` | `components/markdown-view.tsx` | KB rendering (raw HTML; DOMPurify sanitizer deferred — SEC-003) |
| `CreatableField` | `components/creatable-field.tsx` | Inline "New" beside selects → dialog → auto-select |
| `CreateCategoryDialog` | `components/create-category-dialog.tsx` | Reusable category inline create |
| `CreateAssetModelDialog` | `components/create-asset-model-dialog.tsx` | Reusable model inline create |
| `UserAvatar` | `components/user-avatar.tsx` | Avatar from user initials |
| `UserSwitcher` | `components/user-switcher.tsx` | Dev-only shim switcher (goes away with auth) |
| `UserMenu` | `components/user-menu.tsx` | Topbar user menu |
| `RequestIdNote` | `components/request-id-note.tsx` | Copy-to-clipboard request ID in error surfaces |
| `ThemeToggle` | `components/theme-toggle.tsx` | Dark/light mode |
| `SidebarNav` | `components/sidebar-nav.tsx` | App navigation sidebar |

### Error UX (delivered sub-issue #30, 2026-05-26)

- `app/(app)/error.tsx` — Next.js error boundary: shows request ID from ApiError, "Try again" button
- `RequestIdNote` — inline request ID with copy-to-clipboard (used in error boundary and list error states)
- `lib/api/notify-error.ts` — inline mutation errors via Sonner toast

### Data layer convention (ADR-0020)

- `lib/api/endpoints/*.ts` — pure fetch wrappers (one file per entity)
- `lib/api/hooks/*.ts` — TanStack Query hooks
- `lib/api/query-keys.ts` — query key factory per entity
- `lib/api/client.ts` — base fetch with X-User-Id injection from localStorage
- `lib/api/acting-user.ts` — dev shim store (localStorage + events); goes away with auth
- Pages and components consume hooks; never call endpoints directly

---

## Shared (`packages/shared`)

Compiled CJS + d.ts (ADR-0014). Exported via barrel `src/index.ts`.

**Schemas (zod + inferred types)**:
- access-grant, application, application-category
- article, article-category
- asset, asset-assignment, asset-category, asset-expanded, asset-history, asset-model
- consumable, consumable-category, consumable-movement
- location, primitives, search, user

**Utils**: `slug` (kebab-case generator)
**Constants**: `APP_NAME`

All schemas are `z.strictObject` or equivalent — unknown keys rejected at the boundary.

---

## Infrastructure

### Local dev

- `docker-compose.yml` at the repo root
- Services: Postgres (`127.0.0.1:5432`), Meilisearch (`127.0.0.1:7700`), Zitadel DB (internal), Zitadel (`127.0.0.1:8080`)
- All loopback-only or internal (SEC-005 — ADR-0028)
- `bun run dev` runs api + web natively; expects compose to be up

### Production

- `infra/docker-compose.prod.yml`
- Services: db (internal), migrate (one-shot), api, web, meilisearch (internal), zitadel_db (internal), zitadel (internal), caddy (8080/8443 external)
- Caddy routes: `/api` → api, `/` → web, `auth.{LAZYIT_DOMAIN}` → zitadel (ADR-0026/0037)
- Caddy handles TLS + same-origin `/api` routing (ADR-0026)
- Secrets via `infra/env/.env.prod` (ADR-0028)
- Bootstrap runbook: `docs/05-runbooks/auth-bootstrap.md`

### Docker images

- `infra/docker/api.Dockerfile` — multi-stage: Bun build → Node runtime (ADR-0025)
- `infra/docker/web.Dockerfile` — multi-stage: Bun build → Next.js standalone
- `infra/docker/migrate.Dockerfile` — one-shot Prisma migrate + seed

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
- `AssetHistory` — discrete event log (`autoincrement` id)
- `AccessGrant` — access timeline; `revokedAt` closes a grant
- `ConsumableMovement` — stock ledger (`autoincrement` id)

**Soft-deletable (have `deletedAt`)**:
- `User`, `Location`, `AssetCategory`, `AssetModel`, `Asset`
- `ArticleCategory`, `Article`
- `ApplicationCategory`, `Application`
- `ConsumableCategory`, `Consumable`

**Key constraints**:
- `User.id` = uuid (ADR-0005); most others = cuid
- `AssetHistory.id`, `ConsumableMovement.id` = autoincrement (never exposed)
- `User.externalId` = nullable+unique; reserved for OIDC sub
- `AssetAssignment`: partial unique index `(assetId, userId) WHERE releasedAt IS NULL` — raw SQL in migration (Prisma can't express partial indexes)
- Foreign key strategies: Restrict (history-bearing FKs), SetNull (audit actor FKs), Cascade never used

---

## Cross-cutting concerns

### Soft-delete

- Prisma `$extends` client extension in `prisma/soft-delete.extension.ts`
- Filters `deletedAt: null` on `findMany`, `findFirst`, `findUnique` automatically
- Append-only tables (AssetAssignment, AssetHistory, AccessGrant, ConsumableMovement) do NOT soft-delete — they use `releasedAt`/`revokedAt` lifecycle markers

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

- Meilisearch `v1.12.3` in dev compose
- Indexed: assets, articles, users, locations, applications (one index each)
- Sync: fire-and-forget from each service (fail-soft)
- Endpoint: `GET /search?q=&entities=&limit=20`
- Bootstrap: `bun run reindex:all`
- **Not in prod compose** (DevOps pending)

### Actor resolution (ADR-0022, ADR-0024)

- `ActorService` in CommonModule (global)
- Reads `X-User-Id` header → validates as uuid → resolves live User (or 400)
- Used by: AssetAssignments, AccessGrants, Articles (authorId), AssetHistory, Consumables
- Will be replaced by `@CurrentUser()` decorator when auth lands

---

## Known debt (cataloged 2026-05-26)

| Item | Severity | Why deferred | Revisit trigger |
|------|----------|-------------|----------------|
| Meilisearch missing from prod compose | Medium | DevOps hand-off from ADR-0035 | Before first prod deploy |
| SEC-002: .docx decompression bomb | Medium | Deferred to BullMQ worker | When async workers are built |
| SEC-003: latent stored XSS in KB markdown | Low (escalates on exposure) | Deferred to frontend renderer (DOMPurify) | When KB renderer is added/changed |
| SEC-007: no pagination on list endpoints | Low | ADR-0030 contract defined; impl deferred | When any list grows or auth lands |
| Lint ~168 warnings, CI non-blocking | Low | Pre-existing; `continue-on-error: true` | Cleanup sprint |
| `noUncheckedIndexedAccess` not enforced in shared build | Low | Editor-only strictness | When shared tsconfig.build.json is tightened |
| No E2E tests | Low | ADR-0012 deferred; no critical flows exist yet | When auth + key flows exist |
| Dashboard is a placeholder | Low | No metrics defined yet | Medium-term |
| Pagination not implemented (contract in ADR-0030) | Low | MVP scale tolerable | When a list grows or auth gates it |
| Login page is a non-functional placeholder | Pre-auth state | Auth not built | Auth epic |
| `security/summary.md` is stale | Admin | Not updated after remediations on 2026-05-26 | Now (or during next sentinel sweep) |
| `docs/README.md` does not list `06-security` | Admin | Noted by sentinel; out of lane | Doc-only task |

---

## Pending major decisions

| Decision | Status | Gate |
|----------|--------|------|
| **IdP / provider choice** (Authentik vs Keycloak vs Zitadel) | ⬛ Not decided | Blocks auth epic design |
| **IdP database** (shared Postgres vs own DB) | ⬛ Not decided | Blocks DevOps prompt for auth epic |
| **Bring-your-own-IdP configuration surface** | ⬛ Not decided | Part of auth epic scope |
| Async workers: BullMQ + Redis | ⬛ Not decided | SEC-002 (decompression bomb) unblocks on this |
| CD / image publishing (GHCR + deploy flow) | ⬛ Not decided | Deferred in ADR-0027 |
| E2E testing tooling | ⬛ Not decided | Deferred in ADR-0012 |
| Settings backend | ⬛ Not decided | Deferred; no clear trigger |
| Frontend pagination implementation | ⬛ Not decided | ADR-0030 contract set; impl TBD |

---

## Current branch state (2026-05-26)

- Branch: `dev`
- Clean working tree
- Issue #32 (Establish lazyit-cto skill) is open — this session closes it
- All frontend epic sub-issues (#21, #23, #25, #26, #28, #30) are closed; epic #20 closed
- No open PRs
- Next: **auth epic** (pending CEO definition)

---

## Update protocol

Update this file when:
- A new module is added
- An entity is added, renamed, or restructured
- A cross-cutting concern is introduced
- A major architectural decision lands
- Known debt is added or resolved
- A pending decision moves to decided
