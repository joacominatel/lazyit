---
title: "ADR-0068: Asset Tag Scheme — existing-estate awareness (skip-existing allocation invariant + backfill with preview)"
tags: [adr, asset, config, backend, frontend, settings]
status: accepted
created: 2026-06-16
updated: 2026-06-16
deciders: [Joaquín Minatel]
---

# ADR-0068: Asset Tag Scheme — existing-estate awareness (skip-existing allocation invariant + backfill with preview)

## Status

**accepted** — 2026-06-16 (CEO sign-off). Issue #547. **Extends** [[0063-configurable-asset-tag-scheme]]
(the shipped scheme): this ADR makes the scheme aware of the **assets that already exist** when it is
turned on, without changing the OFF-by-default contract or the new-create path for an instance that never
opts in.

## Context

During CEO acceptance testing of the shipped scheme (#363 / [[0063-configurable-asset-tag-scheme]]),
three gaps surfaced — all about how the scheme treats the **pre-existing estate** when enabled. The scheme
is correct for *new* creates but is blind to what is already there:

- **P1 — seed inside the occupied range.** Today `startNumber` seeds the counter blindly. If `IT-1000`
  already exists and the admin starts at 1000, the first allocation renders `IT-1000`, collides (P2002 on
  `assets_assetTag_active_key`), and the bounded retry advances to 1001… — no duplicate is issued, but
  counter numbers are burned and, past the 50-attempt cap, asset creation **fails with a misleading 409**.
- **P2 — enabling the scheme does not tag the existing estate.** [[0063-configurable-asset-tag-scheme]]
  deferred this on purpose. The CEO created tagless assets, enabled the scheme, and nothing got tagged.
- **P3 — no preview of impact.** Changing the scheme / running a backfill should show the assets that will
  be modified before anything is written.

> **CEO, verbatim (2026-06-16):**
> - *(seed)* *"si el startNumber empieza en IT#1000, y ya hay un activo IT#1000, el sistema
>   automáticamente debería pasar al siguiente. Esto es lógica del asset tag y SIEMPRE debe funcionar
>   así… el usuario creó un IT#1000 y un IT#1002 y otro IT#1005. Entonces la idea es que siempre el
>   siguiente sea el valor offset y que no exista."*
> - *(backfill target)* *"por default [solo los sin etiqueta], pero que el usuario pueda elegir
>   [normalizar los no-conformes]. Le damos un aviso."*

## Decision

### 1. Skip-existing allocation invariant (replaces the original "warn vs block" framing)

**An auto-allocated tag is NEVER a tag that already exists on a live asset.** On allocation the counter
always advances to the next number whose rendered tag is free among **live** (non-soft-deleted) assets.
The guarantee is **by construction** (skip-on-exists) and **defended by the live-only partial-unique
index** `assets_assetTag_active_key` ([[0041-soft-delete-reuse-and-restore]]) for concurrent races. This
is unconditional — *"es lógica del asset tag y SIEMPRE debe funcionar así."*

- The previous bounded retry (`MAX_ALLOCATION_ATTEMPTS`) remains only as an **infinite-loop sanity bound**;
  it must **never** surface a false 409 in a dense-occupancy estate. The seed in §2 plus a pre-skip step
  (advance the counter past contiguous-occupied numbers in one shot rather than one P2002 at a time) make
  the cap effectively unreachable; the unique-index retry stays as the concurrency backstop only.
- The counter stays **monotonic with gaps accepted** ([[0063-configurable-asset-tag-scheme]] §3). Interior
  gaps may be filled as the walk passes free slots (e.g. existing `1000, 1002, 1005` → allocations
  `1001, 1003, 1004, 1006…`), which is exactly the CEO's example.

### 2. Seed suggestion at config time

On scheme save, the editor **default-suggests** `startNumber = max(existing matching tag number) + 1` —
parsing the numeric body out of live tags that match the configured `prefix … suffix`. The admin may
override it. A **one-time seed parse** is NOT the ongoing counter mechanism
[[0063-configurable-asset-tag-scheme]] rejected (that rejection was about deriving *every* number from
`MAX()`); from wherever the counter starts, the §1 invariant keeps allocation collision-free regardless.

### 3. Backfill (P2) — explicit, admin-triggered, audited

A deliberate bulk action (`settings:manage`) with **two modes**:

- **Default — `untagged-only`:** only live assets with **no** `assetTag` receive a tag.
- **Opt-in — `normalize-non-conforming`:** additionally re-tag live assets whose tag does **not** match the
  scheme pattern, behind an explicit **warning** (it overwrites a human-set, possibly physically-printed
  identifier). **Conforming manual tags are never touched.**

Forward-only and **audited**: each retag writes an `AssetHistory` row ([[0006-soft-delete-and-auditing]]);
there is **no bulk undo** (fix a wrong tag by editing that one asset). Backfill consumes the same counter
under the §1 invariant (gaps accepted).

### 4. Preview (P3) — read-only, paginated

Before applying, a **paginated, read-only preview** lists exactly the assets a given scope would modify,
**writing nothing** (the counter is not consumed; `proposedTag` is an indicative projection, not a
promise). **Scope** = all-matching (per the mode) + an optional **AssetModel filter**, with **per-row
deselection** in the preview. Apply acts on `(previewed − deselected)` and **re-allocates for real**,
re-validating uniqueness per asset (the §1 invariant already guarantees no duplicate, covering any estate
drift between preview and apply).

## Consequences

- **Positive:**
  - The scheme becomes **estate-aware**: an auto-tag can never collide with an existing tag (the CEO's
    "siempre el siguiente que no exista", guaranteed, not best-effort).
  - An **explicit, audited backfill** with a **safe default** (untagged-only) and a **guarded destructive
    mode** (normalize, behind a warning + full `AssetHistory`).
  - A **preview** so the admin sees impact before writing — *"una lista paginada de los assets que se van a
    modificar."*
- **Trade-offs (accepted):**
  - A new **bulk-mutation surface** (preview/apply endpoints + a settings wizard).
  - **Normalize mode is destructive** — mitigated by the explicit warning + the `AssetHistory` trail; never
    the default.
  - **Preview/apply may drift** if the estate changes between the two — apply re-allocates and re-validates
    per asset, so it stays correct (it just may differ slightly from the preview).
- **Follow-ups (this issue, #547):**
  - **Backend:** harden allocation to the §1 skip-existing invariant (pre-skip + retry backstop, no false
    409 under dense occupancy); a **seed-suggestion** endpoint; **backfill preview/apply** endpoints
    (`settings:manage`); Jest tests for dense-occupancy skip, concurrent no-dup, both backfill modes, audit
    rows, and the OFF-by-default no-op path; the `@lazyit/shared` contract for backfill (see the issue).
  - **Frontend:** the editor's **seed warning + suggest** affordance; a **backfill wizard** (mode toggle
    with the normalize warning, AssetModel filter, paginated preview, per-row deselect, apply + result
    toast), `settings:manage`-gated; i18n en+es.
  - **Docs:** the [[asset]] entity note (backfill + skip-existing semantics).

**Related:** #547 · [[0063-configurable-asset-tag-scheme]] · [[0041-soft-delete-reuse-and-restore]] ·
[[0006-soft-delete-and-auditing]] · [[0036-int4-bounded-integers]] · [[asset]]
