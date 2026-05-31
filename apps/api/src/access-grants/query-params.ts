import { BadRequestException } from '@nestjs/common';
import { PageQuerySchema, type PageQuery } from '@lazyit/shared';

/**
 * Boolean query params shared by the access-grant list endpoints (`/access-grants`,
 * `/users/:id/access-grants`, `/applications/:id/access-grants`). Both default to `true` and only
 * `=false` flips them — anything else (including a bare `?activeOnly`) is treated as `true`.
 */

/**
 * `activeOnly` — defaults to true: only active grants (`revokedAt = null`) unless `activeOnly=false`.
 */
export function parseActiveOnly(value?: string): boolean {
  return value === undefined ? true : value !== 'false';
}

/**
 * `includeExpired` — defaults to true: grants past their `expiresAt` (but not revoked) are still
 * listed unless `includeExpired=false`. `expiresAt` is informative and never changes activeness
 * (no auto-revoke — see docs/03-decisions/0023-access-management-design.md).
 */
export function parseIncludeExpired(value?: string): boolean {
  return value === undefined ? true : value !== 'false';
}

/**
 * Parse the offset/limit pagination query params (ADR-0030) against the shared {@link PageQuerySchema}.
 * Strings from `@Query()` are coerced; an invalid value (limit over the hard max, negative offset…)
 * becomes a clean 400 instead of leaking through to Prisma. Returns the resolved {@link PageQuery}
 * (defaults applied). Reused by the paginated lists in access-grants, assets and articles.
 */
export function parsePageQuery(raw: {
  limit?: string;
  offset?: string;
  page?: string;
}): PageQuery {
  const parsed = PageQuerySchema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(
      'Invalid pagination: limit (1-200), offset (>= 0) and page (>= 1) must be valid integers',
    );
  }
  return parsed.data;
}
