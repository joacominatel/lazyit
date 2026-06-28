---
title: "ADR-0076: Optional Company grouping field on assets (not a tenancy boundary)"
tags: [adr, asset, inventory, grouping]
status: accepted
created: 2026-06-28
updated: 2026-06-28
deciders: [Joaquín Minatel]
---

# ADR-0076: Optional Company grouping field on assets (not a tenancy boundary)

## Status

**accepted** — 2026-06-28. Issue #857. Built same-day: a `company String?` column on `Asset`,
threaded through create/update/list-filter/import/export and the web form/detail/table.

## Context

Operators asked for a Snipe-IT-style "Company" on an asset — to group, filter and report assets by
the organization/business unit they belong to (managed services shops track gear per client; a single
org may split kit by legal entity). The open question (#841) was **what** Company means:

- **Modo A — a plain grouping attribute.** Company is a label on the asset. It groups/filters/reports.
  Everyone with `asset:read` still sees **all** assets regardless of company.
- **Modo B — per-record tenancy/scoping.** Company partitions visibility: a user only sees the assets
  of their company. This is multi-tenancy on a single-org product.

lazyit is deliberately **single-org** ([[0015-deployment-model]]) with a **per-domain RBAC**
model ([[0046-roles-permissions-v2]]) — capabilities are global (`asset:read` means "read assets"),
never per-record. Modo B would introduce a per-record access dimension that touches every asset read,
the RBAC contract, and the audit story — a structural change far beyond the ask.

## Decision

**Company is an optional GROUPING attribute, not per-record scoping. Modo B is rejected (#841).**

- Add an optional free-text `company String?` column on `Asset` (ADR-0006: a mutable-domain column, no
  new entity, no `deletedAt` of its own — it rides the asset's soft-delete).
- It is **not** an access boundary. No RBAC change, no read-scoping logic: anyone with `asset:read`
  sees every asset, exactly as before. Company only **narrows a list the user could already see**.
- **Form: free-text + autocomplete.** The asset form is a plain text input backed by a native
  `<datalist>` populated from the already-used values (`GET /assets/companies`, distinct non-null,
  `asset:read`-gated). The operator reuses an existing value or types a new one — no Company
  entity/table/CRUD/settings page.
- Threaded through the existing asset plumbing, mirroring an existing optional string attribute
  (`notes`): shared zod (`CreateAsset`/`UpdateAsset`/`Asset`), create/update persistence, the list
  filter (exact match, alongside location/category/status), the clone sanitizer, and the bulk importer
  (a recognized, mappable `Company`/`Empresa` column via the descriptor + header aliases).

## Consequences

- Zero blast radius on authz/audit: no read is re-scoped, no permission added, no migration beyond one
  nullable column.
- Free-text means **no governance**: a renamed/misspelled company is a near-duplicate value, and there
  is no soft-delete/merge. Acceptable for a grouping label at this scale; the autocomplete curbs drift.
- Validation is a sane optional trimmed string (max 200), matching `notes` — no enum, no uniqueness.

## Rejected alternatives

- **Modo B (per-record tenancy/scoping)** — rejected (#841): reverses [[0015-deployment-model]]
  and bends the global-capability [[0046-roles-permissions-v2]] model into per-record ACLs.
- **A managed `Company` entity (table + CRUD + settings page)** — over-engineered for a grouping label.
  See the upgrade path below.

## ponytail / upgrade path

`company` is a free-text column with a datalist of existing values — **the laziest correct shape**.
Promote it to a managed `Company` entity (its own table + CRUD, asset FK, governance) **only if**
rename/soft-delete/merge governance is ever genuinely needed. Until then, a flat string + autocomplete
carries the requirement without a new module.
