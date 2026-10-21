import { BadRequestException } from '@nestjs/common';
import {
  ApplicationGrantStatusSchema,
  type ApplicationGrantStatus,
} from '@lazyit/shared';
import { parseBooleanQuery } from '../common/parse-boolean-query';

/** The same bound a grant's `accessLevel` has on write (`CreateAccessGrantSchema`). */
const MAX_ACCESS_LEVEL_LENGTH = 100;
/** A person search is a few words; the bound keeps the token-wise `AND` of `ILIKE`s small. */
const MAX_PERSON_QUERY_LENGTH = 200;

export interface RawApplicationGrantQuery {
  status?: string;
  accessLevel?: string;
  noAccessLevel?: string;
  q?: string;
}

export interface ApplicationGrantQuery {
  status?: ApplicationGrantStatus;
  /** A level, `null` for "no level", absent for any level. */
  accessLevel?: string | null;
  q?: string;
}

/**
 * Parse the per-application grant filters (#1660) shared by the paged list and its export. The global
 * ZodValidationPipe only validates bodies, so a raw `@Query` is checked here and a bad value is a clean
 * 400, never a silent no-filter:
 *
 *   - `status`        — `active` | `expiring` | `revoked` | `all`;
 *   - `accessLevel`   — an exact level, 1-100 characters after trimming;
 *   - `noAccessLevel` — `true` selects grants with no level; sending it with `accessLevel` is a 400;
 *   - `q`             — person search, at most 200 characters; blank means no search.
 */
export function parseApplicationGrantQuery(
  raw: RawApplicationGrantQuery,
): ApplicationGrantQuery {
  const out: ApplicationGrantQuery = {};
  if (raw.status !== undefined) {
    const parsed = ApplicationGrantStatusSchema.safeParse(raw.status);
    if (!parsed.success) {
      throw new BadRequestException(
        `Invalid status: must be one of ${ApplicationGrantStatusSchema.options.join(', ')}`,
      );
    }
    out.status = parsed.data;
  }

  const noLevel = parseBooleanQuery(raw.noAccessLevel, false);
  if (raw.accessLevel !== undefined) {
    if (noLevel) {
      throw new BadRequestException(
        'Send either accessLevel or noAccessLevel=true, not both',
      );
    }
    const level = raw.accessLevel.trim();
    if (level === '' || level.length > MAX_ACCESS_LEVEL_LENGTH) {
      throw new BadRequestException(
        `Invalid accessLevel: 1-${MAX_ACCESS_LEVEL_LENGTH} characters (use noAccessLevel=true for grants with no level)`,
      );
    }
    out.accessLevel = level;
  } else if (noLevel) {
    out.accessLevel = null;
  }

  if (raw.q !== undefined) {
    const q = raw.q.trim();
    if (q.length > MAX_PERSON_QUERY_LENGTH) {
      throw new BadRequestException(
        `Invalid q: at most ${MAX_PERSON_QUERY_LENGTH} characters`,
      );
    }
    if (q !== '') out.q = q;
  }
  return out;
}
