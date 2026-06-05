import { BadRequestException } from '@nestjs/common';

/**
 * The minimal structural shape of a zod enum this helper needs: a `safeParse` that narrows to the
 * enum's literal union and an `options` array for the 400 message. Kept structural (rather than
 * `z.ZodEnum<...>`) so the helper is decoupled from zod's internal enum generics, which differ across
 * major versions.
 */
interface EnumAllowlist<T extends string> {
  safeParse: (
    value: unknown,
  ) => { success: true; data: T } | { success: false };
  readonly options: readonly T[];
}

/**
 * Validate an optional **multi-value** enum query filter against an allowlist (#198) — the array
 * counterpart of the inline single-value enum checks (e.g. `status`, `linkedTo`). A multi-select list
 * filter (`?status=DRAFT,PUBLISHED`) unions several values within one filter; on the wire it is a
 * single **comma-encoded** param (option A — matches the `search.ts` `entities.join(",")` precedent),
 * but a **repeated** param (`?status=DRAFT&status=PUBLISHED`, handed to us as a `string[]`) is accepted
 * too.
 *
 * Splits on `,`, trims, drops empty segments, validates **each** element against `schema` (a zod
 * enum), and **de-duplicates**. An unknown element is rejected with a clean **400** listing the
 * allowed values (ADR-0030: an unknown filter value is never silently ignored). The global
 * ZodValidationPipe only validates `@Body()` DTOs, so raw `@Query` strings are otherwise unchecked —
 * this is where the allowlist is enforced. Returns:
 *   - `undefined` when the filter is absent **or** resolves to no values (so the caller omits it),
 *   - a de-duplicated array of validated enum values otherwise.
 *
 * A single value (`?status=DRAFT`) yields `['DRAFT']` — backward-compatible with the prior
 * single-value contract (existing URLs / deep-links keep working).
 */
export function parseEnumArrayQuery<T extends string>(
  value: string | string[] | undefined,
  schema: EnumAllowlist<T>,
  name: string,
): T[] | undefined {
  if (value === undefined) return undefined;
  const raw = Array.isArray(value) ? value : [value];
  const elements = raw
    .flatMap((part) => part.split(','))
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (elements.length === 0) return undefined;
  const validated = elements.map((element) => {
    const result = schema.safeParse(element);
    if (!result.success) {
      throw new BadRequestException(
        `Invalid ${name}. Expected one of: ${schema.options.join(', ')}`,
      );
    }
    return result.data;
  });
  return [...new Set(validated)];
}
