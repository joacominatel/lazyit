import { z } from "zod";

/**
 * Reusable zod primitives shared by api and web. Keep these framework-agnostic — they describe wire
 * shapes, not behavior. See docs/03-decisions/0036-int4-bounded-integers.md.
 */

/**
 * PostgreSQL `int4` (signed 32-bit) bounds — the range of a Prisma `Int` column. A value outside
 * this range crashes the DB write with P2020 ("value out of range for type integer"); capping the
 * zod schema turns that into a clean 400 at the edge instead.
 */
export const INT4_MIN = -2_147_483_648;
export const INT4_MAX = 2_147_483_647;

/**
 * A signed 32-bit integer that fits a Postgres `Int` column. Always use this for `Int`-backed
 * fields instead of a bare `z.number().int()`: the latter inherits zod's safe-integer bounds
 * (±9_007_199_254_740_991), which (a) overflow an int4 column at write time (P2020 → 500) and
 * (b) make Swagger UI autofill the `maximum` (MAX_SAFE_INTEGER) into the request body. The optional
 * `example` overrides that autofill with a sensible sample in the generated OpenAPI.
 *
 * `min`/`max` narrow the range further (e.g. `{ min: 0 }` for a count); they never widen past int4.
 */
export function int4(opts: { min?: number; max?: number; example?: number } = {}) {
  const min = Math.max(opts.min ?? INT4_MIN, INT4_MIN);
  const max = Math.min(opts.max ?? INT4_MAX, INT4_MAX);
  const schema = z.number().int().min(min).max(max);
  return opts.example === undefined ? schema : schema.meta({ example: opts.example });
}

/**
 * An optional free-text field that treats an empty/whitespace-only string as "absent".
 *
 * The naive `z.string().trim().min(1).max(N).optional()` accepts `undefined` but rejects `""` — yet
 * web forms send `""` for an untouched optional textarea/input, so an empty optional note/reason
 * fails with "Too small: expected string to have >=1 characters" (issue #165). This coerces `""`
 * (and any whitespace-only string) to `undefined`, so a blank optional field is simply omitted; a
 * non-empty value is still trimmed and bounded to `[1, max]`.
 *
 * Both the input and output (inferred) type stay `string | undefined`, so react-hook-form forms
 * that bind `useForm<z.infer<...>>` keep working — unlike `z.preprocess`, which would widen the
 * input type to `unknown` and break the resolver. The leading `.string().trim().max(max)` rejects
 * an over-long value before the empty-string coercion; the trailing `.min(1)` only sees non-empty
 * input. Use for optional notes/reason and similar free text; do NOT use for fields that
 * intentionally accept `null` (the dedicated "clear note" endpoints use `.nullable()`).
 */
export function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value === undefined || value === "" ? undefined : value))
    .pipe(z.string().trim().min(1).max(max).optional());
}

/**
 * Reject an empty PATCH body. Wraps a partial Update*Schema so that `{}` (no fields to change) is a
 * 400 instead of a silent no-op update. A PATCH with nothing to change is almost always a client
 * bug (a misspelled / dropped field name on a strictObject would be stripped to {} and "succeed"
 * without changing anything); requiring at least one key surfaces it. Keys explicitly set to `null`
 * count as a change (clearing a field), so `{ notes: null }` is allowed.
 *
 * Applied to the `.partial()` Update*Schema family. (The notes/expiry update schemas have a single
 * REQUIRED nullable key, so `{}` already fails their base shape — they don't need this.)
 */
export function requireAtLeastOneKey<T extends z.ZodType>(schema: T) {
  return schema.refine((value) => Object.keys(value as object).length > 0, {
    error: "At least one field must be provided to update",
  });
}
