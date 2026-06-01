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
  "deactivated" hint in the avatar stacks. Caveat (same root as the [[0030-list-pagination-contract]]
  lean projection): `GET /users` and `GET /assets` exclude/omit soft-deleted user data, so on the
  **lists** a departed grantee has no identity to draw — the Access list surfaces them as a single
  dimmed placeholder chip (`⊘N`) so the avatar count still matches the grant count. Full
  per-person dimming only happens where the read carries `deletedAt` (the asset/application detail).

## Consequences

- **Positive:** a consistent, testable, copy-pasteable mold; contracts centralized in
  `@lazyit/shared`; predictable cache invalidation via the key factory; components stay free
  of fetching concerns.
- **Trade-offs:** boilerplate per entity (an endpoints file + two hook files); query-key
  discipline is enforced by convention, not tooling.
- **Deferred — not a minor trade-off:** this commits the app to **client-side** data fetching
  (TanStack Query) instead of React Server Components + Server Actions. It is the right call
  *now* — auth/IdP isn't wired ([[0016-auth-strategy-deferred]]) and the screens are
  interaction-heavy (dialogs, optimistic updates) — but it is a real architectural fork that
  **will be revisited** once auth lands and reads can run on the server with a session.
  Migrating later means moving reads into Server Components while keeping the `endpoints/`
  layer; the hooks would shrink to mutation/optimistic concerns.

Related: [[0010-nextjs-frontend]] · [[0011-tailwind-styling]] · [[shared-package]] ·
[[location]] · [[0018-api-documentation-swagger]] · [[0016-auth-strategy-deferred]]
