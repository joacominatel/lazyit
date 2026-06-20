---
id: SEC-072
title: AssetSpecsSchema has no global structural bound (depth/key-count/scalar) and jsonDeepEqual has no depth guard
severity: medium
status: open
cwe: CWE-674
discovered: 2026-06-20
module: assets / import
tags: [dos, recursion, jsonb, specs, import, adr-divergence]
---

# SEC-072 — AssetSpecsSchema lacks global structural caps; jsonDeepEqual depth guard is missing

## Summary

`Asset.specs` (jsonb) has no global bound on nesting depth, key count, or scalar length in the
shared zod schema. `jsonDeepEqual` (`apps/api/src/common/deep-equal.ts`) recurses without a depth
limit on specs data already stored in the DB. Both conditions are now independently reachable via the
bulk-import path (Etapa 2), which admits up to 64 custom keys per session with no depth control on
their values.

## Description

This finding consolidates two related gaps, both deferred from earlier work and now newly reachable
via the import MVP.

### Gap 1 — No global structural bound on `AssetSpecsSchema`

`packages/shared/src/schemas/asset.ts` declares specs as `z.record(z.string(), z.unknown())` (see
also SEC-032 description, accepted debt DEF-004 / ADR-0007). The import MVP adds a **session-local
cap** (≤64 custom keys per session, enforced in `ImportMappingSchema.superRefine`) but does NOT add:

- A **depth cap** on the value of each custom key (a value can itself be a deeply nested object).
- A **key-count cap** on the entire `specs` object globally (multiple import sessions accumulate).
- A **scalar length cap** (a single string value could be very large).

These structural caps are necessary because specs data persists in the DB and is later **read back and
processed** by server-side code (the `jsonDeepEqual` diff on update — SEC-032; any future per-spec
renderer). The import's local cap reduces the surface for NEW specs written via import, but does not
protect specs written by `PATCH /assets/:id` directly (which already existed before this MVP and is
subject to SEC-032 as a separate but related path).

Adding a global structural cap requires a **decision about existing DB rows** (data that already
violates the cap cannot be patched without migration logic) — this is the reason SEC-032 and this
gap were left off the import MVP's critical path. The import-MVP team added the session-level cap as
the minimum viable constraint while deferring the global cap to this finding.

### Gap 2 — `jsonDeepEqual` has no depth guard (extends SEC-032)

SEC-032 documented that `jsonDeepEqual` (`deep-equal.ts:28`, `:38-42`) recurses without a depth
bound and throws a `RangeError` on deeply nested specs. The import MVP does not fix this because:

1. The fix to `jsonDeepEqual` needs to be aligned with the global cap decision (Gap 1): the depth
   guard's cutoff value should match whatever depth the schema enforces.
2. `jsonDeepEqual` runs on **already-persisted specs** (before and after values on `PATCH`), so it
   processes data that pre-exists the import MVP. Fixing Gap 2 without Gap 1 still leaves existing
   rows as potential triggers.

The two gaps are therefore coupled and should be addressed together.

## Impact

**Medium** (elevated from SEC-032's Low because the import path widens the population of deep specs
that can reach the DB). An `asset:write` caller (ADMIN/MEMBER) can:

1. Use the import flow to store deeply-nested `specs` values (the session cap limits key count to 64
   but does not bound value depth).
2. Then PATCH the asset with a comparably deep `specs` — triggering the unbounded recursion in
   `jsonDeepEqual` (SEC-032 PoC applies).

No data is exposed; no process-wide DoS (per-request failure only; the process recovers). Bounded by
`asset:write` privilege and the import session cap. The import path makes the trigger slightly more
accessible (file upload rather than a crafted JSON body), but the core risk is unchanged from SEC-032.

## Proof of concept

Reasoned from code, **not executed**.

```sh
# 1. Prepare a CSV with a custom column whose value is a deeply-nested JSON string.
# 2. Map the column to a custom key via the import wizard (session cap: ≤64 keys, but NO depth cap
#    on the value itself).
# 3. Commit the import → the asset is created with a deeply-nested specs value.
# 4. PATCH /assets/:id with the same nested specs (before and after both non-null) →
#    jsonDeepEqual recurses to the bottom → RangeError (SEC-032 PoC, step 2 of the two-step trigger).
```

Note: the import's `coerce-row.ts` builds specs with `Object.create(null)` (prototype-pollution guard)
but does not apply a depth limit.

## Affected

- `packages/shared/src/schemas/asset.ts:25` — `specs: z.record(z.string(), z.unknown())` (no depth/shape bound; DEF-004).
- `apps/api/src/common/deep-equal.ts:28`, `:38-42` — unbounded recursion (no depth guard).
- `apps/api/src/assets/assets.service.ts:546` — calls `jsonDeepEqual(before.specs, updated.specs)` on every update.
- `packages/shared/src/schemas/import/mapping.ts` — `superRefine` caps key count (≤64) but not value depth.
- (SEC-032 affected files are a subset of this finding.)

## Recommendation

Address both gaps together to avoid inconsistency between the schema cap and the comparator guard.

**Step 1 — Add a depth guard to `jsonDeepEqual`** (`apps/api/src/common/deep-equal.ts`):

```ts
// Add a `depth` parameter (default 0) and a MAX_DEPTH constant (e.g. 10 or matching the schema cap).
// When depth > MAX_DEPTH, treat as "changed" (emit SPECS_CHANGED — harmless and correct-enough).
function jsonDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_SPECS_DEPTH) return false; // treat overly-deep as changed, never recurse further
  // ... existing logic, passing depth + 1 on recursive calls
}
```

This closes the RangeError risk for both the existing PATCH path (SEC-032) and any future specs
written by the import.

**Step 2 — Add a global structural cap to `AssetSpecsSchema`** (coordinate with ADR-0007 follow-up):

Decide on a cap (e.g. max depth 10, max key count 200, max scalar length 2000 chars) and encode it
in the shared schema. Then decide the migration strategy for existing rows that exceed the cap:
- Option A: validate on write only (existing over-deep rows are tolerated in the DB; the cap prevents
  new ones). The `jsonDeepEqual` depth guard from Step 1 handles the read-back path for existing rows.
- Option B: a one-time migration to flatten/truncate existing deep rows.

The import MVP's `ImportMappingSchema.superRefine` (≤64 custom keys per session) is a first-layer
constraint that should be tightened to also validate value depth once the schema cap is defined.

## Prevention

- Add a unit test feeding a pathologically deep object to `jsonDeepEqual` and asserting it returns
  `false` rather than throwing (regression guard for the depth fix).
- When the per-category specs validation lands (ADR-0007 follow-up), include depth/key/scalar bounds
  as mandatory constraints in the catalog.
- Lint rule or code comment on `deep-equal.ts`: "this function runs on DB-persisted data; it MUST
  carry a depth guard."

## References

- SEC-032 (the original `jsonDeepEqual` unbounded-recursion finding; this finding extends and
  supersedes the scope).
- CWE-674: Uncontrolled Recursion. CWE-400: Uncontrolled Resource Consumption.
- ADR-0007 (flexible specs jsonb — per-category validation deferred).
- [[0069-migrator-import]] §A.1 (import MVP specs passthrough + session-local cap).
- `docs/06-security/deferred.md` DEF-004 (unvalidated jsonb — storage angle).
