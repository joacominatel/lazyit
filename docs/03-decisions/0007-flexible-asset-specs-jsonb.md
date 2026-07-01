---
title: "ADR-0007: Flexible asset specs via jsonb"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0007: Flexible asset specs via jsonb

## Status

accepted

## Context

A switch, a laptop and a server have wildly different attributes. Forcing them into one wide
table (mostly-null columns) or a table-per-type explosion both hurt. We need per-type
attributes on [[asset]] without a schema migration for every new attribute.

## Considered options

- **Wide columns** — every possible attribute as a nullable column. Cons: sparse, ever-growing,
  migration-heavy.
- **Table-per-type** — a table per asset category. Cons: rigid; joins and code explode with
  each new type.
- **EAV (entity-attribute-value)** — generic attribute rows. Cons: queries and integrity are
  painful.
- **`specs Json` (jsonb)** — a flexible column on [[asset]] for type-specific attributes.

## Decision

A `specs Json` field (jsonb in Postgres) on [[asset]]. The [[asset-category]] can define the
expected shape of `specs` for its models; stable, frequently-queried attributes graduate to
real columns over time.

`AssetModel.specs` acts as type-level defaults. When an [[asset]] is created with a live model,
those defaults are copied into `Asset.specs` as an editable snapshot. If the create payload already
contains specs, asset-provided keys override model keys. There is no live sync from later model edits
to existing assets.

## Consequences

- **Positive:** add asset types/attributes without migrations; one `Asset` table; Postgres can
  index/query jsonb when needed.
- **Trade-offs:** weaker DB-level typing/validation for `specs` — validate in the app layer
  (zod schema in `@lazyit/shared`, see [[monorepo]]).
- **Follow-ups:** ~~define per-category `specs` zod schemas when categories are implemented.~~
  **Done (2026-06-30, #851) — see [[0078-asset-category-specs-dictionary]].** An `AssetCategory` can
  declare a small **declarative** specs dictionary (`{ key, label, type, required?, enumValues? }[]`,
  stored in `AssetCategory.specsSchema`) that drives **advisory** hints + soft warnings for
  `Asset.specs` (via the pure `validateSpecsAgainstDictionary` helper) — resolved through
  `Asset → model → category`. It is **not** executable zod and **not** hard-blocking: the wire schema
  below stays the open `z.record(...)`, so legacy rows keep validating.
- **Web (delivered):** the asset create/edit form authors `specs` through a **custom-fields
  editor** — a dynamic list of `{ name, value }` string rows (keys validated non-empty + unique)
  that serialize into the `specs` object; the asset detail renders `specs` as a label-cased
  key/value list. The editor handles **scalar string** values only (per "se envie en json y
  listo"); pre-existing non-scalar entries are preserved untouched. The shared schema stays the
  open `z.record(z.string(), z.unknown())` — no narrowing — so legacy data keeps validating.
- **Model defaults UI (delivered):** Settings → Taxonomies → Asset models uses the same key/value
  editor for `AssetModel.specs`. Selecting a model in the asset create form copies those defaults
  into the editable asset specs rows; user-entered asset values still win.
