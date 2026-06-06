---
id: SEC-032
title: Deeply-nested asset specs trigger unbounded recursion in jsonDeepEqual on update (stack-overflow 500)
severity: low
status: fixed
cwe: CWE-674
discovered: 2026-06-06
module: assets
tags: [dos, recursion, jsonb, specs]
---

# SEC-032 — Deeply-nested asset specs trigger unbounded recursion in jsonDeepEqual on update (stack-overflow 500)

## Summary

`PATCH /assets/:id` diffs the old vs new `specs` jsonb with the recursive `jsonDeepEqual`, which has
no depth bound; a deeply-nested `specs` object (within the ~100 kB body limit) recurses past Node's
call-stack limit and throws a `RangeError`, returning an unmapped 500.

## Description

`specs` is unvalidated jsonb (`z.record(z.string(), z.unknown())`, accepted debt DEF-004 / ADR-0007).
`z.unknown()` does not recurse, so arbitrarily deep nesting passes validation. On update,
`AssetsService.changeEvents` decides whether to emit `SPECS_CHANGED` by calling
`jsonDeepEqual(before.specs, updated.specs)` (`assets.service.ts:546`), which recurses once per
nesting level (`deep-equal.ts:28` for arrays, `:38-42` for objects) with no depth guard.

DEF-004 frames the jsonb risk as "stored, not deserialized into behavior" — but this path **does**
process it server-side: a structural recursion driven entirely by attacker-controlled depth. A ~100 kB
body of the form `{"a":{"a":{"a": … }}}` encodes on the order of 10⁴ levels, which can exceed the V8
default stack and throw a stack-overflow `RangeError`.

The early-out `if (a == null || b == null) return false` (`deep-equal.ts:18`) means recursion only
fires when **both** sides are non-null. So the trigger is two requests: (1) create/patch the asset so
a deep `specs` is stored, then (2) patch again with a comparably deep `specs` — now `before` and
`updated` are both non-null and the diff recurses to the bottom.

The `RangeError` is not a Prisma error, so `PrismaExceptionFilter` doesn't map it; it falls through to
a generic 500 (the same unmapped-500 class noted for P2023 in the skill). It is caught by Nest, so the
process survives — this is a per-request failure, not a worker crash.

## Impact

A `asset:write` caller (ADMIN/MEMBER) can make `PATCH /assets/:id` fail with a 500 on demand, and can
leave an asset whose every future spec-changing update 500s (the stored deep `before` keeps tripping
the diff) until the row is overwritten with a shallow `specs`. Bounded by the ~100 kB Express body
limit and the need for `asset:write`; no data exposure, no process-wide DoS. Low. Borderline against
DEF-004: that defers *storage* of unvalidated jsonb, but the **recursion on read-back** is a distinct,
executed code path not covered there.

## Proof of concept

Reasoned from code, **not executed** (exact overflow depth is environment-dependent on the V8 stack
size; the unbounded-recursion shape is the finding).

```sh
# build a ~deep specs payload (single chain), store it, then update again to force the diff
python3 - <<'PY' > body.json
import json
d = v = {}
for _ in range(20000):       # depth within ~100kB once serialized
    v["a"] = {}; v = v["a"]
print(json.dumps({"specs": {"root": d}}))
PY

curl -X POST  -H "X-User-Id: <admin>" -H 'Content-Type: application/json' \
  -d "$(python3 -c 'import json;print(json.dumps({"name":"x","status":"OPERATIONAL"} | __import__("json").loads(open("body.json").read())))')" \
  :3001/assets                                   # store deep specs (id=<a>)

curl -X PATCH -H "X-User-Id: <admin>" -H 'Content-Type: application/json' \
  --data @body.json :3001/assets/<a>             # diff recurses before↔after → RangeError → 500
```

## Affected

- `apps/api/src/assets/assets.service.ts:546` — `changeEvents` calls `jsonDeepEqual(before.specs, updated.specs)` on every update.
- `apps/api/src/common/deep-equal.ts:28`, `:38-42` — unbounded recursion (no depth limit).
- `packages/shared/src/schemas/asset.ts:25` — `specs` is `z.record(z.string(), z.unknown())` (no depth/shape bound; DEF-004).

## Recommendation

Bound the comparison. Cheapest: add a depth/size guard to `jsonDeepEqual` (e.g. a `depth` arg that, if
exceeded, falls back to treating the values as "changed" — emitting a SPECS_CHANGED is harmless and
correct-enough). Stronger and aligned with the long-term plan: cap `specs` nesting depth in the shared
zod schema (a small recursive `z` schema with a max depth, or a pre-parse depth check), which also
caps the eventual per-category `specsSchema` (the TODO in `asset.ts:22`). Either removes the
attacker-controlled recursion.

## Prevention

When the per-category `specs` validation lands (ADR-0007 follow-up), include a max-depth/array-length
bound in the catalog so no unvalidated unbounded structure reaches a recursive consumer; add a unit
test feeding a pathologically deep object to `jsonDeepEqual` and asserting it returns rather than
throwing.

## References

- CWE-674: Uncontrolled Recursion. CWE-400: Uncontrolled Resource Consumption.
- ADR-0007 (flexible specs jsonb), `docs/06-security/deferred.md` DEF-004 (unvalidated jsonb — storage angle).

## Resolution

**Status**: fixed
**Fixed in**: commit `6051c4a` (`fix: bound jsonDeepEqual recursion depth (SEC-032)`)
**Fixed by**: lazyit-remediator
**Date**: 2026-06-06

### Changes
- `apps/api/src/common/deep-equal.ts`: added a `depth` argument (default 0) and a `MAX_DEPTH = 100`
  bound. Past the bound `jsonDeepEqual` returns `false` (treats the values as "changed") instead of
  recursing further; every recursive call threads `depth + 1`. Emitting a spurious `SPECS_CHANGED` is
  harmless and correct-enough; no real specs nest 100 levels deep. The attacker-controlled recursion
  that the `PATCH /assets/:id` diff drove (`changeEvents` → `jsonDeepEqual(before.specs, updated.specs)`)
  can no longer reach a V8 stack-overflow `RangeError` → 500.

### Tests added
- `apps/api/src/common/deep-equal.spec.ts`::"bounds recursion depth instead of overflowing the stack on
  a deep object" — builds two 50,000-deep `{a:{a:…}}` chains; without the fix `jsonDeepEqual` throws a
  `RangeError`, with it it returns (`false`) and does not throw.

### Verification
`bun test apps/api/src/common/deep-equal.spec.ts` → 10 pass / 0 fail (all the existing order-insensitive
/ array / primitive cases still hold; only deep chains short-circuit).

### Residual risk
None for this path. The broader unvalidated-jsonb storage debt (DEF-004 / ADR-0007) is unchanged; the
long-term per-category `specsSchema` should still cap nesting at validation time so no unbounded
structure reaches any recursive consumer.
