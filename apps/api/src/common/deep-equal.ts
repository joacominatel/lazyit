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
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  // Treat null and undefined as equivalent "no specs".
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;

  if (a === b) return true;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) return false;

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => jsonDeepEqual(item, b[i]));
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
        jsonDeepEqual(aObj[key], bObj[key]),
    );
  }

  // Two distinct primitives (already failed === above).
  return false;
}
