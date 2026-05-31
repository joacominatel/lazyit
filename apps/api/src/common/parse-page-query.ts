import { BadRequestException } from '@nestjs/common';
import { PageQuerySchema, type PageQuery } from '@lazyit/shared';

/**
 * Parse the raw pagination query params (`limit` / `offset` / `page`) into the normalized
 * {@link PageQuery} window the services consume. Mirrors `parseUuidQuery` / the inline `status`
 * checks: the global ZodValidationPipe only validates `@Body()` DTOs, so raw `@Query` strings are
 * otherwise unchecked. A malformed or over-max value is a clean **400** (ADR-0030: a `limit` above
 * the hard max is rejected, never silently clamped), and an omitted query yields the defaults.
 *
 * See docs/03-decisions/0030-list-pagination-contract.md.
 */
export function parsePageQuery(raw: {
  limit?: string;
  offset?: string;
  page?: string;
}): PageQuery {
  const result = PageQuerySchema.safeParse(raw);
  if (!result.success) {
    throw new BadRequestException(
      'Invalid pagination: limit (1-200), offset (>=0) and page (>=1) must be integers',
    );
  }
  return result.data;
}
