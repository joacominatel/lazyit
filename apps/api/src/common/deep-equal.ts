/**
 * Order-insensitive structural equality for JSON-compatible values (objects, arrays, primitives).
 *
 * Used to diff an Asset's `specs` jsonb before/after an update (ADR-0033 SPECS_CHANGED). A naive
 * `JSON.stringify(a) !== JSON.stringify(b)` is order-sensitive: Postgres `jsonb` does NOT preserve
 * object key insertion order (it stores a normalized form), so re-saving the same specs with the
 * keys typed in a different order would make the stringified before/after differ and emit a spurious
 * SPECS_CHANGED event. Comparing object keys order-insensitively (arrays stay order-sensitive — order
 * is meaningful in a list) removes that false positive while still detecting any real value change.
 *
 * Scope: JSON values only (the shape `specs` can hold). `null`/`undefined` are treated as the same
 * "empty" so an absent vs explicitly-null spec doesn't read as a change. Not a general deep-equal
 * (no Date/Map/Set/cycles) — `jsonb` round-trips as plain JSON, so those never occur here.
 *
 * Depth is bounded (SEC-032): `specs` is unvalidated jsonb (`z.unknown()`, DEF-004), so a caller can
 * store an arbitrarily deep `{"a":{"a":…}}` chain. Recursing it unbounded blows V8's call stack and
 * 500s the update. Past {@link MAX_DEPTH} we stop and treat the values as "changed" (return false) —
 * emitting a spurious SPECS_CHANGED is harmless and correct-enough, and no real specs nest that deep.
 */
const MAX_DEPTH = 100;

export function jsonDeepEqual(a: unknown, b: unknown, depth = 0): boolean {
  // Treat null and undefined as equivalent "no specs".
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  if (a === b) return true;

  // Bail out before the recursion can overflow the stack (SEC-032). "Too deep to compare cheaply"
  // is reported as a change, never an exception.
  if (depth >= MAX_DEPTH) return false;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => jsonDeepEqual(item, b[i], depth + 1));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    // Order-insensitive over object keys: every key in `a` must exist in `b` with an equal value.
    return aKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(bObj, key) &&
        jsonDeepEqual(aObj[key], bObj[key], depth + 1),
    );
  }

  // Two distinct primitives (already failed === above).
  return false;
}
