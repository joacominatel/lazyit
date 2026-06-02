import { BadRequestException } from '@nestjs/common';
import { PageQuerySchema, type PageQuery } from '@lazyit/shared';

/**
 * Parse the raw pagination query params (`limit` / `offset` / `page` / `sort` / `dir` / `deleted`)
 * into the normalized {@link PageQuery} window the services consume. Mirrors `parseUuidQuery` / the
 * inline `status` checks: the global ZodValidationPipe only validates `@Body()` DTOs, so raw `@Query`
 * strings are otherwise unchecked. A malformed or over-max value is a clean **400** (ADR-0030: a
 * `limit` above the hard max is rejected, never silently clamped; an invalid `dir` is rejected), and
 * an omitted query yields the defaults. `sort` is only shape-validated here (well-formed string) —
 * the per-resource sortable-field ALLOWLIST is enforced in the service via `resolveSortOrBadRequest`.
 * `deleted` selects the soft-delete slice (`active` default | `only`); it is validated here, while
 * the ADMIN gate for `only` lives at each list controller (a non-admin asking for it → 403).
 *
 * See docs/03-decisions/0030-list-pagination-contract.md.
 */
export function parsePageQuery(raw: {
  limit?: string;
  offset?: string;
  page?: string;
  sort?: string;
  dir?: string;
  deleted?: string;
}): PageQuery {
  const result = PageQuerySchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException(
      'Invalid pagination: limit (1-200), offset (>=0), page (>=1) must be integers, dir must be asc|desc and deleted must be active|only',
    );
  }
  return result.data;
}
