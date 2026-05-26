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
