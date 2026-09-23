---
id: SEC-072
title: AssetSpecsSchema has no global structural bound (depth/key-count/scalar) and jsonDeepEqual has no depth guard
severity: medium
status: fixed
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

## Resolution

**Status**: fixed
**Fixed in**: commit `b16128cc` (`fix(shared): bound asset specs structure on write (#1321)`) and commit
`f1b7a3c4` (`fix(api): compare asset specs iteratively in jsonDeepEqual (#1321)`), PR for #1321
**Fixed by**: lazyit-remediator
**Date**: 2026-09-23

Both gaps are closed together, as the finding asked. One deliberate change from the recommendation: the
comparator is made **iterative** instead of getting a depth cutoff. A cutoff that returns "changed"
past a depth would emit a spurious `SPECS_CHANGED` on every edit of a legacy deep row; an explicit
stack compares exactly at any depth, so the comparator no longer needs to match the schema's depth
cap at all.

### Changes

- `packages/shared/src/schemas/asset.ts`: a structural write bound on `specs`. `CreateAssetSchema` and
  `UpdateAssetSchema` use `AssetSpecsWriteSchema` (the open record plus a `superRefine`); `AssetSchema`,
  the read shape, keeps the unbounded record. The walk is iterative and never descends past the depth
  cap. It reports the first violation with its path under `specs`. Exported bounds:
  - `ASSET_SPECS_MAX_DEPTH = 32` (the specs object is level 1; arrays count as levels)
  - `ASSET_SPECS_MAX_KEYS = 256` (per object, the top level included)
  - `ASSET_SPECS_MAX_ARRAY_LENGTH = 10_000`
  - `ASSET_SPECS_MAX_STRING_LENGTH = 10_000` (string values and object keys)
- `apps/api/src/common/deep-equal.ts`: `jsonDeepEqual` walks with an explicit stack. The semantics
  are unchanged: null and undefined are equivalent, object keys are compared order-insensitively, and
  arrays are compared order-sensitively.
- `packages/shared/src/schemas/import/mapping.ts`: **no change needed**. A custom field's value is
  always the raw cell **string** (`coerceRow` never parses it as JSON), so an import cannot deepen
  `specs`. The finding's step 1 assumed otherwise. The dry-run and the commit both re-validate every
  coerced row with `CreateAssetSchema.safeParse`, so the global bound applies to import rows
  automatically: a cell past 10 000 characters fails that row on `specs`, and the ≤64-custom-field
  session cap already sits under the per-object key cap. The re-import UPDATE path writes the same
  validated data, and it replaces `specs` rather than merging it, so keys do not accumulate across
  sessions.
- `apps/api/src/assets/assets.service.ts`: no change. The `changeEvents` call site is safe now that
  the comparator is safe.

### Why these bounds

Every legitimate writer sits well under each cap:

- **Web custom-fields editor**: flat string rows, depth 1.
- **Import**: at most 64 string cells per row.
- **Reporting agent**: its facts reach `Asset.specs` server-side, bypassing the schema. The web edit
  form re-sends every preserved non-scalar entry on each save, so an agent-backed asset must still
  pass the bound. `AgentReportSchema` caps them at about 6 levels of nesting
  (`host.nics[].ipv6[].address`), 5000 `software` entries, 256 disks, 64 NICs × 64 addresses, and
  strings of at most 1024 characters.

Against those writers:

- **Depth 32** is 5× the deepest legitimate shape, and still trivially safe for any recursive
  consumer.
- **10 000 array items** is 2× the agent's `software` cap.
- **256 keys per object** is 4× the import's per-session custom-field cap. No agent object comes
  close.
- **10 000 characters** is 5× the longest string cap in the asset contract (`notes` 2000) and 10× the
  agent's longest string. It also fits a pasted PEM certificate chain.

Total size stays bounded by the JSON body limit (`JSON_BODY_LIMIT`, 8 MB by default).

### Tests added

- `apps/api/src/common/deep-equal.spec.ts`::`pathologically deep values (SEC-032)`: three cases on
  100 000-level object and array chains, covering equal chains, a changed leaf, and array chains.
  **Failed on `dev`** with `RangeError: Maximum call stack size exceeded`. They pass with the fix.
- `apps/api/src/assets/assets.service.spec.ts`::`updates an asset whose STORED specs predate the write
  bound without failing (SEC-032 upgrade path)`: a status-only `update()` on a row whose stored specs
  are 100 000 levels deep. **Failed on `dev`** with `RangeError`. It passes with the fix, emitting only
  `STATUS_CHANGED` and no spurious `SPECS_CHANGED`.
- `packages/shared/src/schemas/asset.test.ts` (new): the SEC-032 reproduction (a 20 000-level chain)
  is rejected without throwing on create and update. It also checks the exact limit and one past it
  for depth (objects and arrays), keys, array length, and string values and keys; that the issue path
  starts at `specs`; that an agent-backed specs at every `AgentReportSchema` cap is accepted; and that
  `AssetSchema` still accepts a stored over-bound row. **7 of 10 failed on `dev`** (every rejection
  case; the 3 acceptance cases are regression guards). All 10 pass with the fix.
- `packages/shared/src/schemas/import/mapping.test.ts`::`custom fields under the global specs bound
  (SEC-072)`: a custom cell past the string bound fails the per-row `CreateAssetSchema` on `specs`.
  A cell that looks like 500-level JSON stays a string, and 64 custom fields validate.

### Verification

- A 6 MB body with 1 000 000 levels (under the 8 MB limit) is parsed by `JSON.parse` in about 90 ms.
  `UpdateAssetSchema` then rejects it in about 1 ms with `must nest at most 32 levels deep`, which the
  global zod pipe returns as a 400, not a 500.
- The full API Jest suite passes: 174 suites, 2916 tests.
- `packages/shared`: 1243 pass. `apps/web`: 1017 pass.
- `tsc --noEmit` is clean for shared, api, web and agent.

### Residual risk

- **Existing over-bound rows are tolerated, not rewritten.** They still read and list. A `PATCH`
  without `specs` still succeeds, and the diff is now exact. Re-sending the over-bound `specs` is a
  400 until it is replaced with a compliant object. Only a hand-crafted API payload could have
  produced such a row; an over-bound non-scalar entry is fixed through the API, since the web editor
  cannot remove non-scalar entries.
- **`AssetModel.specs` is not bounded.** Its defaults are merged into a new asset's specs on create
  after validation. The merge is shallow and nothing downstream recurses over it now, but the bound
  does not cover it. The model schema was out of this unit's scope.
- **Agent-written specs bypass the schema by design.** They stay under the bound because
  `AgentReportSchema` caps them. If an agent contract cap is ever raised past these bounds,
  agent-backed assets would stop being editable in the web form.
