---
title: Code Conventions
tags: [development]
status: draft
created: 2026-05-25
updated: 2026-06-01
---

# Code Conventions

Conventions for application code. Data-model conventions live in [[conventions]] (Domain).

## Language

- **English everywhere** — code, identifiers, comments, and these docs.

## TypeScript

- **Strict** TypeScript across all workspaces.
- Shared contracts (zod schemas, inferred types, constants, pure utils used by both web and
  api) live in `@lazyit/shared` — one definition, imported via `workspace:*`. Never duplicate
  a contract in an app. What may live there is governed by a contract → [[shared-package]].

## Backend (NestJS)

- Organize by **module per bounded area** ([[02-domain/_MOC|Domain]]): assets, tickets,
  access, consumables, knowledge base.
- Use dependency injection; e.g. a single injectable `PrismaService` (next code step after
  the domain model — [[0002-nestjs-backend]], [[0003-prisma-orm]]).
- Validate input with zod schemas from `@lazyit/shared`.
- **Integers backed by a Postgres `Int` column use `int4()`** from `@lazyit/shared`, never a bare
  `z.number().int()` — the latter inherits zod's safe-integer bounds, which overflow the column
  (P2020 → 500) and make Swagger UI autofill `MAX_SAFE_INTEGER` ([[0036-int4-bounded-integers]]).
- **Soft delete is automatic** ([[0032-soft-delete-middleware]]): a Prisma `$extends` filter scopes
  reads on soft-deletable models to `deletedAt: null` — don't re-add manual `where: { deletedAt: null }`
  guards. Use `findFirst` (not `findUnique`) for soft-delete-aware lookups by id; pass
  `{ includeSoftDeleted: true }` to bypass (restore / audit).
- **Soft-delete reuse + restore** ([[0041-soft-delete-reuse-and-restore]]): natural-key uniques on
  soft-deletable models (`email`, `name`, `slug`, `sku`, `serial`, `assetTag`) are NOT `@unique` —
  they're PARTIAL unique indexes `WHERE "deletedAt" IS NULL` (raw SQL in the migration, like
  AssetAssignment), so a soft-deleted value is reusable. Each soft-deletable entity has an ADMIN-gated
  `POST /<resource>/:id/restore` that finds the row via `includeSoftDeleted`, clears `deletedAt`, and
  (for Asset) emits a `RESTORED` history event. `User.email` is `citext` — normalize emails
  (`trim().toLowerCase()`) on write. A new natural-key unique on a soft-deletable model should follow
  this partial-index pattern, not a plain `@unique`.

## Observability — logging

Structured logging is **Pino** via **`nestjs-pino`** ([[0031-logging-strategy]]). In practice:

- **Don't `console.log`.** Inject `PinoLogger` (or a Nest `Logger`) and log structured objects —
  `this.logger.info({ assetId }, 'asset created')`. Nest's own logs already route through Pino.
- **Levels are a four-word vocabulary** mapped onto Pino: `trace`/`debug` → **DEBUG**, `info` →
  **INFO**, `warn` → **WARNING**, `error`/`fatal` → **CRITICAL**.
- **Never log secrets or bodies.** `authorization`, `cookie` and the `x-user-id` header are redacted;
  request/response bodies are not logged. The caller's id is logged as the `actor` field.
- **Request id is automatic** — every line of a request carries it (honored from `X-Request-Id` or
  generated, echoed on the response). Don't roll your own correlation id.
- **Errors:** throwing is enough — the global `AllExceptionsFilter` logs ≥ 500 faults with their
  stack. Don't `catch`-and-log-and-rethrow just to record an error.

## Frontend (Next.js)

- App Router, TypeScript, Tailwind v4 ([[0010-nextjs-frontend]], [[0011-tailwind-styling]]).
- **shadcn/ui is installed** ([[0011-tailwind-styling]]). Its generated primitives live in
  `apps/web/components/ui/*` (copy-in, not a dependency) and are composed by app components in
  `apps/web/components/` and the route trees. Treat `components/ui/*` as vendored: regenerate via
  the shadcn CLI rather than hand-editing, and build features by composing those primitives.
- **Icons: heroicons only — everywhere, including `components/ui/*`** ([[0045-icon-library-heroicons]]).
  `@heroicons/react` is the project's single icon vocabulary; `lucide-react` was removed entirely
  (it must not reappear in `apps/web/package.json` or any import). **Two-weight convention:**
  **`/24/outline` is the default** (nav, actions, standalone icons — the vast majority);
  **`/16/solid` is the single small variant** for dense inline / indicator / badge contexts (menu
  check/chevron indicators, select chevrons, checkbox, table sort arrows, toast status badges).
  Do **not** introduce a third weight (no `/24/solid`, `/20/solid`) or a second icon family. Size
  via Tailwind classes (`size-4` / `size-5`), not by switching SVG variant. **`shadcn add` caveat:**
  shadcn's `iconLibrary` has no heroicons option, so a freshly-generated primitive will import
  `lucide-react` — re-map those imports to heroicons (per ADR-0045's mapping table) before
  committing.
- **Chrome primitives — compose, don't re-implement.** The page-frame patterns were copy-pasted
  ~16× and drifted (title scale `text-2xl` vs `text-3xl`; ad-hoc "Back to X" ghost buttons;
  unnamed search/filter inputs). Three shared primitives now own them:
  - `components/page-header.tsx` — `PageHeader` ({ `title`, `subtitle?`, `breadcrumb?`,
    `actions?`, `badge?` }). The **only** sanctioned page title; the scale is fixed inside it.
    Never hand-roll an `<h1 className="text-2xl/3xl …">` page title — compose this.
  - `components/breadcrumb.tsx` — `Breadcrumb` (route-driven via `usePathname`; pass explicit
    `items` on detail pages to surface a record's real name). Rendered once at the app-shell
    layout level; it **replaces** per-page "Back to X" buttons.
  - `components/search-input.tsx` — `SearchInput` ({ `value`, `onChange`, optional
    `debounceMs`+`onDebouncedChange`, `label` (default "Search"), `placeholder`, clearable }).
    Carries an accessible name by default — list filters must name their search box.
- **Navigation IA — three pillars + Manage.** `components/sidebar-nav.tsx` groups nav into
  **Inventory** (Assets, Consumables) · **Access** (Applications) · **Knowledge** (Knowledge
  Base) · **Manage** (Users, Locations), with Dashboard ungrouped on top. The user-facing noun
  is **Applications** (route stays `/applications`); **Access** is the pillar name, not a nav
  label. `mobile-nav.tsx` reuses `SidebarNav`, so it inherits the grouping.

## The Bun-first boundary

> [!important] Read [[0009-bun-first-vs-app-stack]]
> Bun is **scoped** (decided 2026-05-25, written into the root `CLAUDE.md`):
> - **Bun** = runtime, package manager, scripts/tooling, and tests for `shared`/scripts.
> - **App layer** = NestJS (Express) for HTTP, Prisma for data, **Jest** for API tests.
>
> Don't "fix" Express→`Bun.serve` or Prisma→`Bun.sql` to match the old blanket Bun-first
> wording; that divergence is deliberate and now documented in `CLAUDE.md`.

## Testing

- Unit tests **always**; core/complex logic gets thorough, many-cased testing. Priority is
  the application core, not scaffolding/UI. Full policy: [[0012-testing-strategy]].
- Runners: **Jest** (`apps/api`) · **`bun test`** (`packages/shared`). Frontend unit tests and
  e2e are **deferred**. No global coverage gate — rigor on the core via review.

## Workflow

- Every change follows [[claude-workflow]]: context first, ask-don't-assume, front/back via
  separate subagents, file-scoped commits, and **docs kept in sync** (review `docs/` on any
  core change; never commit docs that reference removed files or a changed philosophy).

Related: [[claude-workflow]] · [[workflows]] · [[setup]] · [[conventions]] · [[shared-package]] ·
[[0009-bun-first-vs-app-stack]] · [[0012-testing-strategy]]
