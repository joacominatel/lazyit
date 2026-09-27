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
 * ITERATIVE, NOT RECURSIVE (SEC-032 / SEC-072). This runs on specs already in the database, which may
 * predate the write bound in `@lazyit/shared` and nest arbitrarily deep; a recursive walk would overflow
 * the call stack on such a row and turn every later update of it into a 500. An explicit stack keeps
 * the result exact at any depth, so a legacy row neither fails nor reports a change that did not happen.
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  const pending: [unknown, unknown][] = [[a, b]];
  while (pending.length > 0) {
    const [x, y] = pending.pop()!;
    // Treat null and undefined as equivalent "no specs".
    if (x == null && y == null) continue;
    if (x == null || y == null) return false;

    if (x === y) continue;

    const xIsArray = Array.isArray(x);
    const yIsArray = Array.isArray(y);
    if (xIsArray !== yIsArray) return false;

    if (xIsArray && yIsArray) {
      if (x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) pending.push([x[i], y[i]]);
      continue;
    }

    if (typeof x === 'object' && typeof y === 'object') {
      const xObj = x as Record<string, unknown>;
      const yObj = y as Record<string, unknown>;
      const xKeys = Object.keys(xObj);
      if (xKeys.length !== Object.keys(yObj).length) return false;
      // Order-insensitive over object keys: every key in `x` must exist in `y` with an equal value.
      for (const key of xKeys) {
        if (!Object.prototype.hasOwnProperty.call(yObj, key)) return false;
        pending.push([xObj[key], yObj[key]]);
      }
      continue;
    }

    // Two distinct primitives (already failed === above).
    return false;
  }
  return true;
}
