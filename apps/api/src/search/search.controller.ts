import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { SearchResultsSchema } from '@lazyit/shared';
import {
  readableIndexes,
  SEARCH_INDEXES,
  SearchService,
  type SearchIndex,
  type SearchResults,
} from './search.service';
import { CurrentUser } from '../auth/current-user.decorator';
import { CurrentPrincipal } from '../auth/current-principal.decorator';
import { RequirePermission } from '../auth/require-permission.decorator';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import type { Principal } from '../auth/principal';
import type { User } from '../../generated/prisma/client';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

// OpenAPI response shape for GET /search: the shared SearchResults envelope ({ assets, articles,
// users, locations, applications } — each entity key optional). Single source of truth (ADR-0018).
class SearchResultsDto extends createZodDto(SearchResultsSchema) {}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly permissions: PermissionResolverService,
  ) {}

  // `search:read` gates the endpoint. The ADDITIONAL tightening (ADR-0046 P3, AUD-015) is at the RESULT
  // level: each index is searched only for a caller holding that entity's `<domain>:read`, the same
  // permission its dedicated GET routes require — so a VIEWER cannot enumerate the user directory, and a
  // role edited to lose `asset:read` gets no asset hits — whether the index was asked for explicitly or
  // implicitly via "search all".
  @Get()
  @RequirePermission('search:read')
  @ApiOperation({
    summary:
      'Cross-entity search (Meilisearch). Returns one { hits, total } block per requested entity, or per entity when omitted. An entity is omitted for a caller without its read permission (asset:read, article:read, user:read, location:read, application:read, infra:read, consumable:read; purchaseOrder:read for purchases and suppliers) — by default a VIEWER gets no users, purchases or suppliers.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Query string. Defaults to "" (returns top documents per index).',
  })
  @ApiQuery({
    name: 'entities',
    required: false,
    description: `Comma-separated subset of: ${SEARCH_INDEXES.join(', ')}. Omit to search all.`,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: `Per-index hit cap (${MIN_LIMIT}-${MAX_LIMIT}). Default ${DEFAULT_LIMIT}.`,
  })
  @ApiOkResponse({ type: SearchResultsDto })
  async find(
    @CurrentUser() user?: User,
    @CurrentPrincipal() principal?: Principal,
    @Query('q') q?: string,
    @Query('entities') entities?: string,
    @Query('limit') limit?: string,
  ): Promise<SearchResults> {
    const requested = parseEntities(entities);
    const allowed = await this.allowedEntities(requested, user, principal);
    // An empty `allowed` (a caller who asked ONLY for indexes it cannot read) must return an empty envelope — NOT be
    // re-expanded to "all" by the service (which treats `[]` as all). Short-circuit it here.
    if (allowed !== undefined && allowed.length === 0) {
      return {};
    }
    return this.search.search({
      q: q ?? '',
      entities: allowed,
      limit: parseLimit(limit),
      // ADR-0060 §5: the principal drives the article folder-access post-filter (ADMIN sees all; SA
      // fails closed; anonymous → PUBLIC-folder hits only) so a restricted article never leaks here.
      principal,
    });
  }

  /**
   * Drop every index whose read permission the principal lacks ({@link readableIndexes} — resolved per
   * principal, so a service account needs the direct grant). `users` additionally needs a human caller
   * whose role holds `user:read` (ADR-0046 P3 as built). `requested === undefined` means "search all":
   * we materialize the full index list so we can subtract from it. A caller who may read every requested
   * index gets the request back unchanged (still `undefined` = all when they asked for everything).
   *
   * Returns `[]` (not `undefined`) when nothing the caller asked for is readable, so the caller can
   * tell "nothing left to search" from "search everything" — the `find` handler short-circuits it.
   */
  private async allowedEntities(
    requested: SearchIndex[] | undefined,
    user?: User,
    principal?: Principal,
  ): Promise<SearchIndex[] | undefined> {
    const base = requested ?? [...SEARCH_INDEXES];
    const canReadUsers =
      user !== undefined &&
      (await this.permissions.hasAll(user.role, ['user:read']));
    const allowed = (
      await readableIndexes(this.permissions, base, principal)
    ).filter((index) => canReadUsers || index !== 'users');
    return allowed.length === base.length ? requested : allowed;
  }
}

/**
 * Parse the comma-separated `entities` param into the valid {@link SearchIndex} subset, preserving
 * the canonical order and dropping duplicates/unknowns. Returns `undefined` (= all) when nothing
 * valid is requested, so an empty/garbage value falls back to searching every index.
 */
function parseEntities(raw?: string): SearchIndex[] | undefined {
  if (!raw) return undefined;
  const wanted = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const valid = SEARCH_INDEXES.filter((index) => wanted.has(index));
  return valid.length > 0 ? valid : undefined;
}

/** Clamp `limit` to {@link MIN_LIMIT}..{@link MAX_LIMIT}; non-numeric/absent -> {@link DEFAULT_LIMIT}. */
function parseLimit(raw?: string): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.trunc(parsed)));
}
