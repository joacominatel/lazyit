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

- Organize by **module per bounded area** ([[02-domain/_MOC|Domain]]): assets,
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
- **Design-system activation tokens & recipes** ([[0049-activated-restraint-ux-direction]],
  extends [[0011-tailwind-styling]]). Compose these instead of hand-rolling colour/depth/motion:
  - **Elevation:** `shadow-e1` (resting cards/panels) · `shadow-e2` (hover/focus) · `shadow-e3`
    (dialogs/dropdowns/sticky). Warm-tinted, with dark parity baked into the token — use these,
    not ad-hoc `shadow-md/lg`.
  - **The `lift` recipe** (`lib/recipes.ts`) — the coordinated hover triad (`-translate-y-0.5`
    + `shadow-e1`→`e2` + ring `/10`→`/15`). Apply at call sites: `<Card className={lift}>`.
    Reduced-motion-safe (globals.css neutralizes the translate). Don't add it to static table
    rows (vertical jitter hurts scanning).
  - **Motion utilities:** `animate-rise-in` (component-level entrance settle, 12px rise + fade) ·
    `animate-fade-in` (opacity-only sibling for the ROUTE-level settle — no transform, so it never
    traps `position: sticky` descendants in a containing block) · `animate-pulse-soft` (the ONE
    calm attention heartbeat — danger dots only) · `animate-shimmer` (skeleton sweep, composed
    at call sites — never edit `ui/skeleton.tsx`) · `animate-check-draw` (success-check; the
    only `--ease-spring` use). All collapse to instant under `prefers-reduced-motion` via the
    single consolidated block in globals.css. Easing/duration tokens: `--ease-out-quad` /
    `--ease-spring` / `--dur-fast|base|slow`. `app/(app)/template.tsx` gives every route a
    free `fade-in` cross-route settle (opacity only — sticky-safe).
  - **Pillar colour** (`bg-pillar-*` / `text-pillar-*`, registered like `--color-avatar-*` so
    the JIT scanner keeps full class strings — **never** `bg-[var(--pillar)]/10`). LOCKED map:
    **Inventory = teal · Access = indigo (the brand) · Knowledge = green · Manage = rose**;
    **Consumables shares Inventory teal** (differentiate by icon, never a 5th hue).
    `<PillarScope pillar>` (`components/pillar-scope.tsx`) sets an inherited `--pillar` var
    (brand-indigo fallback when omitted) for chrome that wants the *route's* pillar; surfaces
    that statically know their pillar use the `bg-pillar-*` utility directly.
  - **The pillar-AA rule (HARD):** pillar hue is a **tint / border / dot / chip ONLY — never
    small text on the bone canvas** (the chart hues can't clear 4.5:1 as body text on the
    0.985 bone). A decorative ≥24px glyph in a `bg-pillar-*/10` chip is fine (glyphs are exempt
    from text-AA); readable text always stays on `--foreground` / `--card-foreground` / a
    token's AA-verified `*-foreground`. Status colour stays on the semantic tokens
    (`--success`/`--warning`/`--info`/`--destructive`) via `StatusBadge`. **Raw Tailwind
    palette colours** (`bg/text-{emerald,sky,violet,amber,rose,teal,indigo}-NNN`) are flagged
    by an eslint guard in web feature code — use the tokens.
  - **`<EmptyState>`** (`components/empty-state.tsx`) — the warm "nothing here yet" surface
    (pillar-tinted icon chip + invitation + optional action, `rise-in` on mount). Compose it
    instead of dashed-border boxes (rollout is in progress).
  - **Type tokens:** `text-display` (hero metrics) · `text-section` (panel headings) ·
    `text-label` (uppercase eyebrows) carry the size+line-height+tracking triple — use them
    instead of pixel-guessing.
- **Design context — use the `impeccable` skill for any UI/UX work.** For any design,
  redesign, critique, audit, or polish task, run `/impeccable <command>`. The strategic
  context (register, users, brand personality, anti-references, design principles) lives in
  the **root `PRODUCT.md`**; the visual system (tokens, colour roles, typography, elevation,
  components, do's/don'ts — extracted byte-for-byte from `globals.css`) lives in the **root
  `DESIGN.md`** with a machine-readable sidecar at `.impeccable/design.json`. The
  reconciliations baked into `DESIGN.md`'s Do's and Don'ts are **binding**: pillar identity is
  a tint/chip/dot only (no colored `border-left/right` > 1px; ≤2px active-nav rule is the only
  exception); motion is CSS + tw-animate-css only (**no** framer-motion/gsap/anime/lenis); the
  warm `--bone` canvas is a committed ADR-0011 decision, not an "AI cream default"; and no
  hollow hero-metric template, gradient text, glassmorphism, per-section eyebrows, or nested
  cards.

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
