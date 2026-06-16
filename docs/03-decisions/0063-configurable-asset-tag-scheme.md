---
title: "ADR-0063: Configurable Asset Tag Scheme — instance config + monotonic counter, OFF by default"
tags: [adr, asset, config, backend, frontend, settings]
status: accepted
created: 2026-06-14
updated: 2026-06-14
deciders: [Joaquín Minatel]
---

# ADR-0063: Configurable Asset Tag Scheme — instance config + monotonic counter, OFF by default

## Status

> **Implemented (backend, 2026-06-16, #363):** `AssetTagScheme` single-row model + `asset_tag_scheme`
> migration (singleton-id CHECK), the `@lazyit/shared` `AssetTagSchemeSchema` / `UpdateAssetTagSchemeSchema`
> (the running number is modelled as explicit fields, so a `{num}`-less config is unrepresentable),
> `GET`/`PUT /config/asset-tag-scheme` (`settings:manage`), and in-create atomic allocation with bounded
> retry-on-P2002 (`AssetTagSchemeService.allocateTag` + the `AssetsService.create` retry loop). The
> settings UI is the frontend follow-up.

**accepted** — 2026-06-14 (CEO sign-off). Issue #363. This is lazyit's **first instance-configuration
store** — a dedicated, single-row config entity that holds an org-wide setting (the asset-tag template)
plus a global counter — so it sets the pattern for instance config to come. It builds on the flexible
specs decision ([[0007-flexible-asset-specs-jsonb]]), the live-only partial-unique conventions
([[0041-soft-delete-reuse-and-restore]]) and the id strategy ([[0005-id-strategy]]).

> **Scope of this ADR.** A new single-row **`AssetTagScheme`** config entity + a **global monotonic
> counter**, a template with a **mandatory `{num}` token** (+ optional prefix/suffix and zero-padding),
> **in-transaction allocation with retry-on-collision** during asset create, **gaps accepted**, and
> **OFF by default** (no scheme ⇒ no auto-tag; the existing manual `assetTag` is unchanged). This ADR
> defines the model and the allocation rules; the implementation is the follow-up.

## Context

Small IT teams label their hardware with a running asset tag — `LAZY-00042`, `IT-2026-0107`. Today
[[asset]] has a **manual, optional `assetTag`** column: live-only partial-unique
(`assets_assetTag_active_key` per [[0041-soft-delete-reuse-and-restore]]), set by hand on create/edit.
That is fine for ad-hoc tagging but does not give a team **a consistent, auto-incrementing scheme** —
the operator types each tag and is responsible for never colliding or skipping.

The CEO wants an **opt-in** configurable scheme: define a template once (prefix + a mandatory running
number + optional suffix/padding) in setup, and have new assets get the next tag automatically. The
decisive constraint, verbatim:

> *"Apagado hasta configurar"* — the feature is **OFF by default**. With no scheme configured, asset
> creation must behave exactly as it does today (no auto-tag); the manual `assetTag` keeps working
> unchanged. Turning it on is a deliberate act in settings.

Two forces shape the design:

- **A monotonic running number needs a single source of truth.** A "next number" that two concurrent
  asset-creates could read at the same time would hand out a duplicate tag. The counter must be
  allocated atomically, inside the create transaction, and survive a unique collision.
- **This is the first instance config.** lazyit has per-role config (`RolePermission`,
  [[0046-roles-permissions-v2]]) and per-entity settings, but **no org-wide, single-row instance-config
  table** exists yet. The asset-tag scheme is one — a single row that holds an instance-wide setting.
  Getting its shape right (single-row, no soft-delete, a clear "unset" state) sets the precedent.

## Considered options

- **A dedicated single-row `AssetTagScheme` entity + a global counter (chosen).** A purpose-built config
  row holding the template (prefix/suffix/padding) and the monotonic `nextNumber` (or a separate counter
  row). Allocation increments the counter inside the asset-create `$transaction`. Clean, explicit, and a
  reusable pattern for future instance config.
- **Stuff the scheme into the existing config/permissions surface or an env var — rejected.** Env vars
  are deploy-time, not in-app-editable, and can't hold a live counter. Overloading the permission/config
  tables conflates authorization config with a domain-numbering scheme. A dedicated entity is clearer and
  is the precedent we want for instance config.
- **Derive the next number from `MAX(assetTag)` at create time — rejected.** Parsing the number back out
  of a formatted, prefixed tag is fragile (prefix/padding changes break it), and `MAX`-over-a-formatted-
  string is not a reliable monotonic source. A real counter column is the honest mechanism.
- **A Postgres `SEQUENCE` for the counter — rejected for v1.** A DB sequence is monotonic and concurrency-
  safe, but it is **invisible to Prisma** (extra raw-SQL migration surface), harder to reset/seed, and its
  gap-on-rollback behaviour is the same as our chosen "gaps accepted" anyway — with none of the
  in-row, in-app-editable ergonomics. A counter **column on the config row**, incremented in the same
  `$transaction`, keeps the whole scheme in one editable, Prisma-modelled place. (A sequence stays a
  valid future optimization if counter contention ever becomes real, which at 5–20-person scale it won't.)

## Decision

Adopt a **dedicated single-row `AssetTagScheme` config entity + a global monotonic counter**, allocated
in-transaction with retry, **OFF by default**.

### 1. `AssetTagScheme` — lazyit's first instance-config entity (single-row)

A new **single-row** config entity holding the org-wide asset-tag scheme:

- A **template** with a **mandatory `{num}` token** (the running number), plus **optional `prefix` /
  `suffix`** and a **zero-padding width** (e.g. width 5 → `00042`). Examples: `LAZY-{num}` → `LAZY-42`,
  `IT-2026-{num}` (width 4) → `IT-2026-0107`. The `{num}` token is **required** — a scheme without it
  has no running number and is rejected at config time.
- A **global monotonic counter** — the next number to allocate (a `nextNumber` / `counter` field, or a
  sibling counter row). It is **org-wide** (one running sequence for the whole instance), not per-prefix
  or per-category in v1.
- An **`enabled` flag** is implicit in *existence + configuration*: see §4 (OFF by default).

**Conventions.** As **mutable instance config**, not append-only domain data: `createdAt` + `updatedAt`.
It is a **single row** (the instance's one scheme) — enforced as a singleton (a fixed primary key / a
single-row guard), the same "this is small configuration, the row IS the identity" spirit as
`RolePermission` ([[0046-roles-permissions-v2]] §3). The counter is **not** soft-deletable and is never
reset by a delete — disabling the scheme leaves the counter where it was (so re-enabling continues, it
does not restart). Editing the template (prefix/suffix/padding) does **not** rewrite already-issued tags;
it only affects future allocations. The id follows [[0005-id-strategy]] for a config/singleton row.

> **First instance-config precedent.** This is the **first** org-wide, single-row instance-config store
> in lazyit. Future instance-wide settings should follow this shape (a dedicated single-row entity,
> mutable config timestamps, an explicit "unset/disabled" state), rather than env vars or overloading a
> domain table.

### 2. The template + the `{num}` token

Rendering a tag is: `prefix + zeroPad(num, width) + suffix`, where `{num}` is substituted by the
allocated counter value. `{num}` is **mandatory** (validated in the shared zod schema for the config
write). Prefix/suffix are optional free text; width is an optional non-negative pad. The rendered result
is what lands in `Asset.assetTag` — so it is subject to the **same live-only partial-unique constraint**
the manual tag already has (§3).

### 3. Allocation — in the asset-create `$transaction`, retry on collision, **gaps accepted**

When the scheme is enabled, creating an [[asset]] that does **not** carry an explicit `assetTag`
allocates one:

- **Inside the asset-create `$transaction`.** The counter is read-and-incremented and the tag rendered
  **within the same transaction** that inserts the asset, so two concurrent creates cannot read the same
  number. The increment is atomic (an `UPDATE … SET nextNumber = nextNumber + 1 RETURNING`-style read, or
  the equivalent Prisma `update` with `{ increment: 1 }`), so the counter is the single monotonic source.
- **Retry on unique-collision.** The rendered tag still hits the **live-only partial-unique index**
  `assets_assetTag_active_key` ([[0041-soft-delete-reuse-and-restore]]) — e.g. if a manual tag already
  took the value the formula produced. On a P2002 collision the allocation **retries** with the next
  counter value (bounded retries), so a clash advances rather than fails the create.
- **Gaps are accepted.** A counter value consumed by a **rolled-back** transaction, a retried collision,
  or a later **deleted/soft-deleted** asset is **not back-filled**. The sequence may have holes
  (`…0041, 0043, 0044…`). This is the deliberate, documented trade-off: gap-free numbering would require
  serializing all asset creation through a single lock and reclaiming numbers on delete, which is not
  worth it for a 5–20-person team. The counter is monotonic, not gapless.

### 4. OFF by default — the load-bearing CEO constraint

- **With no scheme configured (or the scheme disabled), asset creation does NOT auto-assign a tag.**
  The create path behaves **exactly as it does today**: `assetTag` is whatever the operator typed (or
  null). No counter is touched, no template is rendered, no behaviour changes for an instance that never
  opts in.
- **The existing manual `assetTag` keeps working unchanged** — live-only partial-unique
  ([[0041-soft-delete-reuse-and-restore]]), set by hand on create/edit, freed on delete and reclaimed on
  restore. The scheme is **additive**: even with a scheme enabled, an operator may still pass an explicit
  `assetTag` on create, and that explicit value **wins** (the scheme only fills the gap when no tag is
  supplied) — mirroring the "asset-provided keys override model defaults" precedent of
  [[0007-flexible-asset-specs-jsonb]].
- Turning the scheme **on** is a deliberate settings action (the config write that sets the template +
  the starting number). Turning it **off** stops auto-allocation but does not touch the counter or any
  issued tag.

## Consequences

- **Positive:**
  - An **opt-in, consistent, auto-incrementing** asset-tag scheme that a team can configure once — and
    that is **invisible** to an instance that doesn't want it (OFF by default; today's behaviour
    preserved exactly).
  - The **first instance-config precedent**: a clean single-row config entity + counter pattern for
    org-wide settings to reuse.
  - **Concurrency-safe** monotonic numbering (in-transaction counter increment) with **collision-safe**
    retry against the existing partial-unique tag index — no duplicate live tags, ever.
  - Reuses what exists: the live-only partial-unique `assetTag` index
    ([[0041-soft-delete-reuse-and-restore]]), the "explicit value wins over a default" pattern
    ([[0007-flexible-asset-specs-jsonb]]), and the soft-delete/restore lifecycle for tags.
- **Negative / trade-offs (accepted):**
  - **Gaps in the sequence** — a rolled-back/retried/deleted allocation leaves a hole; numbering is
    monotonic, not gapless. Accepted (gap-free would need a global serialization + reclaim).
  - **A new config entity + migration** and a config UI surface in settings — the standard cost of an
    in-app-editable scheme (vs an env var that couldn't hold a live counter).
  - **Org-wide counter only** in v1 — no per-prefix or per-category sub-sequences. Adequate for the
    target; a future ADR can add scoped counters if a team needs them.
  - **An enabled scheme does not retroactively tag existing assets** — only new creates get auto-tags;
    back-filling the estate is an explicit, separate action if ever wanted.
- **Follow-ups:**
  - The `AssetTagScheme` Prisma model (single-row guard) + counter + migration; the shared zod config
    schema validating the mandatory `{num}` token; the in-transaction allocation + bounded retry-on-P2002
    in the asset-create service; the settings UI to configure/enable the scheme; tests for concurrency
    (no duplicate), collision-retry, gap-on-rollback, and the OFF-by-default no-op path.

**Related:** #363 · [[0007-flexible-asset-specs-jsonb]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] · [[0046-roles-permissions-v2]] (config
precedent) · [[asset]]
