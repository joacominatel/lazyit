import { BadRequestException } from '@nestjs/common';
import { parseCuidQuery } from './parse-cuid-query';

/**
 * Validate an optional **multi-value** cuid query filter — the array counterpart of
 * {@link parseCuidQuery} (#198). A multi-select list filter (e.g. `?categoryId=cuid1,cuid2`) lets the
 * client union several values within one filter; on the wire it is a single **comma-encoded** param
 * (option A — matches the `search.ts` `entities.join(",")` precedent), but a **repeated** param
 * (`?categoryId=cuid1&categoryId=cuid2`, which Express/Nest hand us as a `string[]`) is accepted too,
 * so either client encoding works.
 *
 * Splits on `,`, trims, drops empty segments, validates **each** element with the single-value
 * {@link parseCuidQuery} (so an unknown/garbage element still maps to a clean **400** — ADR-0030 /
 * SEC-004, never a silently-empty list), and **de-duplicates** (a `{ in: [...] }` filter is set
 * semantics — a repeated value is redundant). Returns:
 *   - `undefined` when the filter is absent **or** resolves to no values (so the caller omits it),
 *   - a de-duplicated `string[]` of well-formed cuids otherwise.
 *
 * A single value (`?categoryId=cuid1`) yields `['cuid1']` — backward-compatible with the prior
 * single-value contract (existing URLs / dashboard deep-links keep working).
 */
export function parseCuidArrayQuery(
  value: string | string[] | undefined,
  name: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const elements = raw
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (elements.length === 0) return undefined;
  // Reuse the single-value contract element-wise: each element is a clean 400 on garbage.
  const validated = elements.map((element) => {
    const parsed = parseCuidQuery(element, name);
    // parseCuidQuery only returns undefined for an absent value; a non-empty element is never absent,
    // but narrow defensively so the result type stays string[].
    if (parsed === undefined) {
      throw new BadRequestException(`Invalid ${name}: expected a cuid`);
    }
    return parsed;
  });
  return [...new Set(validated)];
}
