import { BadRequestException } from '@nestjs/common';
import {
  resolveSort,
  UnknownSortFieldError,
  type PageQuery,
} from '@lazyit/shared';

/**
 * Resolve a {@link PageQuery}'s `sort`/`dir` into a Prisma `orderBy` against a per-resource
 * allowlist, mapping the shared {@link UnknownSortFieldError} to a clean **400** (ADR-0030 amendment:
 * an unknown sort field is rejected, never silently ignored — so a sort always means what it says).
 * Returns `undefined` when the caller passed no `sort` (the service then uses its own default order).
 *
 * The allowlist maps each PUBLIC sort key (what the client sends in `?sort=`) to the Prisma field to
 * order by — bounding the sortable surface to a curated set per resource. See
 * docs/03-decisions/0030-list-pagination-contract.md.
 */
export function resolveSortOrBadRequest<TOrderBy>(
  query: Pick<PageQuery, 'sort' | 'dir'>,
  allowlist: Record<string, string>,
): TOrderBy | undefined {
  try {
    return resolveSort<TOrderBy>(query, allowlist);
  } catch (err) {
    if (err instanceof UnknownSortFieldError) {
      throw new BadRequestException(err.message);
    }
    throw err;
  }
}
