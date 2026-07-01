---
title: "ADR-0078: Advisory per-category specs dictionary (extends ADR-0007)"
tags: [adr, asset, asset-category, specs, governance]
status: accepted
created: 2026-06-30
updated: 2026-06-30
deciders: [Joaquín Minatel]
---

# ADR-0078: Advisory per-category specs dictionary (extends ADR-0007)

## Status

**accepted** — 2026-06-30. Issue #851. Closes the long-standing `TODO(specs)` deferred by
[[0007-flexible-asset-specs-jsonb]]. Extends (does not supersede) ADR-0007.

## Context

`Asset.specs` is flexible jsonb ([[0007-flexible-asset-specs-jsonb]]) but has **no governance**:
nothing nudges every asset of one type toward the same keys (e.g. every Proxmox host carrying
`cluster`). Consistency depended entirely on operator discipline. The gap was already flagged as debt
(`TODO(specs)` in `packages/shared/src/schemas/asset.ts` and `asset-model.ts`). The ask (#851, from an
MSP/ex-ServiceNow reviewer) was a **per-category dictionary** — the lightweight equivalent of a
ServiceNow CI-class dictionary — that validates and autocompletes `specs` **without losing the jsonb
flexibility** and **without breaking existing rows**.

## Decision

**An [[asset-category]] MAY declare a DECLARATIVE specs dictionary; it is ADVISORY, never blocking.**

- **Storage.** A new nullable `specsSchema Json?` column on `AssetCategory`. `null` = no governance
  (the ADR-0007 default: any jsonb object is accepted). Non-destructive: existing rows stay `null`.
- **Shape — a small declarative field list, NOT executable zod, NOT a JSON-Schema engine.** Each field
  is `{ key, label, type: 'string' | 'number' | 'boolean' | 'enum', required?: boolean,
  enumValues?: string[] }`. The list has unique keys; an `enum` field must declare ≥1 value. Both API
  and web interpret the same list. Defined once in `@lazyit/shared`
  (`schemas/asset-specs-dictionary.ts`) as `AssetSpecsDictionarySchema` + `SpecFieldSchema`.
- **Advisory-first (the core posture).** The dictionary produces **soft warnings + UI hints**, never a
  400. A pure, framework-agnostic helper `validateSpecsAgainstDictionary(specs, dictionary)` returns a
  list of `{ key, code }` warnings (`missingRequired` | `wrongType` | `notInEnum` | `unknownKey`).
  Extra keys are allowed (just flagged); the wire schema for `Asset.specs` stays the open
  `z.record(z.string(), z.unknown())` — it never narrows, so legacy data keeps validating.
- **Lenient type checks.** The web custom-fields editor stores every spec value as a **string**
  (ADR-0007), so the `number`/`boolean` checks accept numeric/boolean-looking strings (`"16"`,
  `"true"`); `string` never mismatches; `enum` checks membership against `enumValues`. Otherwise every
  typed field would warn on real data and the feature would be pure noise.
- **Resolution path.** An asset's dictionary is resolved through its model:
  `Asset → model → category.specsSchema`. The expanded asset read already inlines `model.category`, so
  the category dictionary travels with the asset; the asset form resolves it from the selected model's
  category.
- **Editing.** The dictionary is authored in the existing **Settings → Taxonomies → Asset categories**
  manager (no new nav) — a per-category field-list editor, asset-categories only.

## Scope

- **Assets only.** `InfraNode.specs` ([[0070-infra-topology-graph]]) is explicitly **out of scope**.
- **No versioning.** The dictionary is a live list; there is no schema-version history. Editing it does
  not rewrite existing assets (consistent with the ADR-0007 "model defaults are a snapshot" rule).
- **No hard/blocking validation, no data migration.** Existing `specs` are untouched.

## Consequences

- **Positive:** operators get consistency nudges (declared fields, required hints, type/enum warnings,
  autocomplete) per asset type, closing the ADR-0007 follow-up — while keeping every escape hatch open
  (extra keys allowed, no write ever rejected, no migration of old rows).
- **Trade-offs:** advisory means a determined operator can still save divergent specs. That is the
  deliberate posture (opinionated defaults, not a straitjacket). Promote to hard validation only if a
  real need appears — see the upgrade path.
- **Blast radius:** one nullable column + one shared schema/helper + the category service passthrough +
  two web surfaces (the category editor and the asset form's specs hints). No change to the asset
  create/update contract, no new endpoint, no authz change.

## Rejected alternatives

- **Executable per-category zod / a general JSON-Schema engine** — over-engineered for a 5–20-person
  estate; a serializable field list both sides interpret is enough (ponytail).
- **Hard/blocking validation (400 on non-conforming specs)** — rejected for v1: it would break the
  "existing rows stay valid" guarantee and the opinionated-but-not-rigid posture. Kept as an explicit
  upgrade path.
- **A dictionary on `AssetModel`** — the category is the right altitude (the *type*), and models already
  inherit their category; per-model schemas would fragment governance.

## ponytail / upgrade path

The dictionary is a plain declarative list stored in one nullable jsonb column, interpreted by one pure
helper — the laziest correct shape. If governance ever needs teeth, the same list can back **opt-in
hard validation** (a per-category "enforce" flag flipping the helper's warnings into a 400 on the asset
write path) without changing the stored shape. Until then, advisory hints carry the requirement.
