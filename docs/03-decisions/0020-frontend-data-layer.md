---
title: "ADR-0020: Frontend data layer (endpoints → hooks → components)"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0020: Frontend data layer (endpoints → hooks → components)

## Status

accepted — **implemented and verified** with the first two features (Locations CRUD, then
Users CRUD) in `apps/web`. This is the template every entity screen that follows (Knowledge
Base, Assets, …) copies. Before the third screen, the repeated scaffolding was promoted into
shared building blocks — see *Shared abstractions* below.

## Context

`apps/web` now consumes the REST API ([[0010-nextjs-frontend]], [[stack]]). Without a
convention, every screen would re-invent fetching, caching and form validation, and
components would call `fetch` ad hoc — drifting from the contracts in `@lazyit/shared`
([[shared-package]]). We want one layered template, with web↔api contracts anchored in the
shared zod schemas. The first feature, Locations — the simplest domain entity ([[location]])
— serves as the mold.

## Considered options

- **`fetch` directly inside components** — rejected: duplication, no caching, contracts drift
  from `@lazyit/shared`.
- **A single fat `api` client object** — rejected: weaker per-resource clarity and
  tree-shaking than small endpoint modules.
- **React Server Components + Server Actions for data** — deferred (see Consequences).
- **A client generated from the OpenAPI/Swagger doc** ([[0018-api-documentation-swagger]]) —
  possible future; the hand-written thin layer is enough today and keeps types sourced from
  `@lazyit/shared`.

## Decision

A three-layer data path, plus query-key, form and component-placement conventions.

### Layers

1. **`lib/api/endpoints/<resource>.ts`** — pure `async` functions (`getLocations`,
   `createLocation`, …). The **only** code that calls `apiFetch` (the typed wrapper over
   `fetch`). Request/response types come from `@lazyit/shared`. No React, no cache.
2. **`lib/api/hooks/use-<resource>.ts` (+ `…-mutations.ts`)** — TanStack Query wrappers over
   the endpoints. Reads expose the query keys; mutations invalidate them on success. Hooks
   never call `fetch`/`apiFetch` directly — only the endpoints.
3. **Pages and components** consume hooks only. They never fetch directly.

### Query-key conventions

Each resource exports a **query-key factory** so reads and the mutations that invalidate them
can't drift. The shape (as implemented in `locationKeys`):

- `<entity>Keys.all` → `["locations"]` — the root/prefix for the whole resource.
- `<entity>Keys.lists()` → `["locations", "list"]` — the list query.
- `<entity>Keys.detail(id)` → `["locations", "detail", id]` — a single record.

Mutations invalidate `<entity>Keys.all`; being the common prefix, it refetches both lists and
details. Future resources copy this verbatim: `userKeys`, `assetKeys`, …

### Forms

Forms use `react-hook-form` + `@hookform/resolvers` with the **shared zod schema** as the
single validation source (e.g. `CreateLocationSchema`), wired through shadcn's `Field`
primitives. Empty optional inputs are mapped to `undefined` (not `""`) so the strict shared
schema (`z.strictObject` with `.optional()`) treats them as untouched.

**Multi-schema forms.** The simple case is one schema for both modes (`Location`: edit just
PATCHes the same fields). When create and edit validate against *different* shared schemas —
not merely `Update = Create.partial()` but a **different field set** — the dialog picks the
resolver by mode (`zodResolver(isEdit ? UpdateXSchema : CreateXSchema)`) and the parent
**remounts it via `key`** (`key={editing ? \`edit-${id}\` : "create"}`), so `isEdit` and the
resolver stay fixed for the component's lifetime instead of switching mid-render. The first
case was `User`: `CreateUserSchema` omits `isActive` (new users are always active; deactivation
is a PATCH), while `UpdateUserSchema` adds it — so the `isActive` switch renders only in edit,
and `toFormValues` omits the key on create so the strict create schema still passes.

### Component placement

- **`app/(app)/<feature>/_components/`** — UI private to one feature. The `_` prefix opts the
  folder out of Next.js App Router routing.
- **`apps/web/components/`** — cross-cutting components, promoted here on **genuine** reuse,
  never speculatively. `<UserAvatar>` was promoted early by explicit exception; the table
  scaffolding (`<ResourceTable>` + list states) and `<DeleteConfirmDialog>` were promoted once
  the third screen made the duplication real — see *Shared abstractions* below.
- **`apps/web/components/ui/`** — reserved for vendored shadcn primitives
  ([[0011-tailwind-styling]]); not hand-authored as feature code.

### Shared abstractions (extracted at the third screen)

Locations was the mold; Users proved it replicates (~⅓ the effort). Before the third screen the
copy-paste was promoted into shared building blocks — the canonical pieces new screens compose
instead of re-deriving:

- **Data layer:** `createCrudEndpoints<TEntity, TCreate, TUpdate>(base)` (the five REST bodies)
  and `createQueryKeys(name)` (the `all` / `lists` / `detail` factory). Generics are supplied at
  each call site, so every resource keeps fully typed, **named** functions (`getLocations`, …);
  the helpers only remove the `apiFetch` / key boilerplate. Resources with extra endpoints
  (`publish`, `by-slug`, …) spread the CRUD result and add their own typed functions.
- **UI:** `<ResourceTable>` (bordered shell + header from a `columns` config + the loading and
  filtered-empty states) with `RowActions` / `EmptyState` / `ErrorState`; `<DeleteConfirmDialog>`
  (entity label + record name + a `mutateAsync` thunk — it owns the spinner, toasts and close);
  and `formatDate` in `lib/utils/format.ts`.
- **Error UX (extracted across the screens):** `notifyError(error, fallback)`
  (`lib/api/notify-error.ts`) is the single error-toast entry point — message + the API request id
  (`ApiError.requestId`, captured by `apiFetch` from `X-Request-Id` — [[0031-logging-strategy]]) as a
  copyable detail; it replaced the per-file `errorMessage()`/`toast.error` copies. Unexpected errors
  hit the `(app)/error.tsx` boundary; `<RequestIdNote>` renders the id in both the boundary and
  `ErrorState`. Recoverable (mutation/validation) → toast; unexpected (render/load) → boundary.

**Deliberately _not_ extracted — a generic hooks factory.** A `createCrudHooks(...)` returning a
fixed `useList` / `useDetail` / `useCreate` / … set was considered and rejected: (1) it erodes the
`react-hooks` lint analysis and greppability that explicit `useXxx` definitions give; (2) every
real entity past trivial CRUD needs **bespoke** hooks (`usePublishArticle`, `useAssignUser`, a
`by-slug` read) that a fixed factory can't express, forcing a mixed style in one file; (3) the
hooks are 3–5 lines each and read better written out. The criterion is **per-resource type
clarity > deduplication**: abstract the endpoint/key boilerplate (pure, fully typed), keep the
hooks hand-written. Revisit only if a later entity makes the hooks genuinely identical *and*
numerous.

### Detail pages and the per-entity related-reads (2026-06-01)

The list mold has a **detail-page** counterpart: a `(<entity>)/[id]/page.tsx` that reads the one
record and its **related** sub-resources, then cross-links them. The pattern, as implemented:

- **Nested reads** ride the entity's own endpoint file + query-key factory, with the nested key
  composed under `detail(id)` so invalidating the entity (or `all`) refetches the panels. New here:
  `getUserAssignments` / `getUserGrants` (`GET /users/:id/{assignments,access-grants}`) and the
  `userKeys.{assignments,grants}(id, activeOnly)` keys; the access-grant **edit** writes
  (`updateAccessGrantNotes` / `updateAccessGrantExpiry` → `PATCH /access-grants/:id/{notes,expiry}`)
  whose mutation hooks invalidate the grant **and** the application **and** the user caches.
- **Asset-centric per-person view.** `users/[id]` is the User counterpart to `assets/[id]`: it shows
  the person's held assets ([[asset-assignment]]), their application access ([[access-grant]] — the
  per-user "who can access what" angle), and the [[article]]s they authored. The nested grant/
  assignment reads are **lean** (FK ids only — the controller doesn't `includeUser`/inline the
  asset), so labels are resolved client-side from the catalog reads (`useAssets`/`useApplications`),
  and every reference is a link both ways (user ⇄ application, user ⇄ asset).
- **`locations/[id]`** shows the place plus the assets physically there, via the existing
  `useAssets({ locationId })` server filter — no new endpoint.
- **Access-edit UX.** A grant's **`expiresAt`** and **`notes`** are editable from the application
  detail (an `EditGrantDialog` per active row, firing only the changed field); `accessLevel` uses a
  shared **combobox** (`components/access-level-combobox.tsx`, an input + native `<datalist>` of the
  common values) — it stays **free-form** (the schema is, deliberately — [[0023-access-management-design]]),
  so the suggestion list lives in `web`, not `@lazyit/shared`. The grant dialog shows the grantee's
  existing active grants on the app as context.
- **Deactivated grantees/owners flagged in lists.** Soft-deleted people render dimmed + a
  "deactivated" hint in the avatar stacks. The **asset list** now dims departed owners directly:
  `GET /assets` re-added `activeAssignments[].user.deletedAt` ([[0030-list-pagination-contract]]
  amendment §3), so a soft-deleted owner is drawn grayscale exactly like the detail read. The
  **Access list** still can't draw a departed grantee's identity — its count read (`GET /users`)
  excludes soft-deleted rows — so it surfaces them as a single dimmed placeholder chip (`⊘N`) to keep
  the avatar count matching the grant count.

### List-page chrome & URL view-state (2026-06-01)

The list mold gained a shared chrome layer so all six list pages (assets, applications/Access,
consumables, users, locations, kb) stay identical in structure and behaviour — see
[[0030-list-pagination-contract]] amendment §6 for the full rollout:

- **`useListParams(...)`** (`lib/hooks/use-list-params.ts`) makes the **URL the source of truth** for
  list view-state (`q` / `sort` / `dir` / `limit` / `offset` / named `filters`) — replacing each
  page's local `useState` cluster, so lists are shareable, bookmarkable, Back-navigable and
  deep-linkable from the dashboard.
- **Chrome primitives:** `<PageHeader>` (one fixed title scale + actions/subtitle), `<SearchInput>`
  (accessible, clearable, self-debouncing), `<ActiveFilters>` + `ClearFiltersLink`
  (`components/active-filters.tsx`, the dismissible filter chips + "Clear all" / in-row recovery).
- **`<ResourceTable>` is now responsive:** a `mobileChildren` slot plus `<ResourceCard>` /
  `<ResourceCardMeta>` render each row as a touch-friendly stacked card below `md`, with the
  `<table>` at `md`+. The page builds its rows once and hands the table a desktop and a mobile
  projection. `<SortableHeader>` is wired to `toggleSort` for **server-side** sort (only the
  per-resource allowlist columns are sortable).
- **The four interim list fetchers** (`getUsers`/`getLocations`/`getApplications`/`getConsumables`)
  now take a params object and return the **whole `Page<T>` envelope**. The bare directory hooks
  (`useUsers`/`useLocations`/`useApplications`) keep their `Entity[]` contract for client-side joins
  by requesting the max page (200) and `select`-ing `items`; dedicated `useUserList`/`useLocationList`/
  `useApplicationList` hooks return the envelope for the list pages.
- **RBAC:** write affordances (New X, per-row Edit/Delete, consumable ±1 quick-adjust) are gated on
  `useCanWrite()` (the API is still the real gate).

### "Clone a record" — pre-filled create off the existing forms (2026-06-02)

A **Clone** affordance opens the existing **create** form pre-filled from an existing record (issue
#125). It is a pure-frontend feature: a clone is just a normal create body against the existing POST
endpoints (which already enforce the partial-unique indexes and the soft-delete contract) — **no new
endpoints, no `?cloneFrom=` transport**. The mold:

- **Sanitizers in `@lazyit/shared`** (`src/clone/clone-defaults.ts`, unit-tested with `bun test`):
  one pure mapper per entity returning a `CreateX`-shaped partial. **Never a blind spread** — each is
  explicit: unique partial-index fields are CLEARED (`Asset.serial`/`assetTag`, `Consumable.sku`,
  `AssetModel.sku`) so the create can't 409 and the operator notices the empty field; a category's
  unique `name` is suffixed " (copy)"; `jsonb` (`specs`/`metadata`) is DEEP-COPIED (`structuredClone`).
  **`User` is security-sensitive**: it copies only `firstName`/`lastName`, forces `email` to "",
  **never** carries `externalId` (SEC-006) and **omits** `role` so the server applies its default
  VIEWER (least privilege — a clone must not carry ADMIN/MEMBER from the source).
- **Page-route forms** (Asset, Consumable, Application) gain a dedicated `/<res>/[id]/clone` route that
  mirrors `/[id]/edit` (fetch by id) and renders the create form with a `cloneSource` prop — the form
  stays in CREATE mode (CreateX resolver + create mutation), pre-filled from the sanitizer.
- **Dialog forms** (AssetModel, the four Categories, User) gain a `cloneSource` prop (distinct from
  their edit prop) and a "Clone" row action that opens the create dialog pre-filled, **remounted via
  `key={`clone-${source.id}`}`** so it stays in create mode with fresh state. Fields with no UI input
  but a meaningful clone (`AssetModel.specs`, `Application.metadata`) ride straight into the create
  body.
- **Entry points & gating:** `RowActions` gained an OPTIONAL `onClone` (a "Clone" item between Edit and
  Delete, additive — existing call sites unaffected); detail pages get a Clone button beside Edit.
  Every entry point is gated on `useCanWrite()` (a clone is a create; fails closed while loading) and
  is **never shown in the archived `deleted=only` view** (where Edit is already hidden).

### Server-prefetch extension to the three-layer path (2026-06-23)

The "Deferred" fork below — moving reads onto the server once auth landed — has now been **partially
taken**, without disturbing the three layers. Auth landed ([[0039-authjs-v5-frontend-oidc]]), so
[[0067-server-prefetch-ssr-strategy]] added a **fourth, optional layer on top** of the existing
three: a thin `async` Server Component `page.tsx` that `prefetchQuery`s the route's **primary** read
into a per-request `QueryClient`, `dehydrate()`s it, and wraps the interactive client view in
`<HydrationBoundary>`. The endpoints layer is **reused unchanged** (a getter gains only an optional
trailing `token?: string` for the server's Bearer, since the client token store is browser-only); the
hooks are **untouched** (the child `useQuery` finds the dehydrated entry on first paint instead of
fetching). The key the page prefetches is built from the **same key factory** the hook uses, so they
can't drift. The pilot (#537) converted the six high-traffic list routes; the full rollout (#662)
extended the mold to detail/edit/clone, KB, reports and the settings pages with a clear single
primary read.

What stays client-fetched, deliberately: secondary/related reads (prefetch only the primary to keep
the change uniform); filtered/paged/searched first paints (only the unfiltered default is
prefetched — a filtered URL degrades to a client fetch); and the **Secret Manager** entirely (it is
`ssr: false` by design for INV-10 / zero-knowledge — [[0061-secret-manager-zero-knowledge]] — and its
safe metadata reads are inseparable from the ciphertext/wrapped-key reads that feed client-side
decryption). The operating manual for applying this to a new route is [[ssr-prefetch-recipe]].

## Consequences

- **Positive:** a consistent, testable, copy-pasteable mold; contracts centralized in
  `@lazyit/shared`; predictable cache invalidation via the key factory; components stay free
  of fetching concerns.
- **Trade-offs:** boilerplate per entity (an endpoints file + two hook files); query-key
  discipline is enforced by convention, not tooling.
- **Deferred — not a minor trade-off (now partially resolved):** this committed the app to
  **client-side** data fetching (TanStack Query) instead of React Server Components + Server
  Actions. It was the right call when written — auth/IdP wasn't wired
  ([[0016-auth-strategy-deferred]]) and the screens are interaction-heavy (dialogs, optimistic
  updates). Once auth landed, the fork was taken the **minimal** way (not a full RSC migration):
  reads now run on the server via server-prefetch + hydration, the `endpoints/` layer is reused and
  the hooks are unchanged. See the *Server-prefetch extension* section above and
  [[0067-server-prefetch-ssr-strategy]].

Related: [[0010-nextjs-frontend]] · [[0011-tailwind-styling]] · [[shared-package]] ·
[[location]] · [[0018-api-documentation-swagger]] · [[0016-auth-strategy-deferred]] ·
[[0067-server-prefetch-ssr-strategy]] · [[ssr-prefetch-recipe]]
