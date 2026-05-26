import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  SEARCH_INDEXES,
  SearchService,
  type SearchIndex,
  type SearchResults,
} from './search.service';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
const MIN_LIMIT = 1;

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary:
      'Cross-entity search (Meilisearch). Returns { assets, articles, users, locations, applications } — only the requested entities, or all when omitted.',
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
  async find(
    @Query('q') q?: string,
    @Query('entities') entities?: string,
    @Query('limit') limit?: string,
  ): Promise<SearchResults> {
    return this.search.search({
      q: q ?? '',
      entities: parseEntities(entities),
      limit: parseLimit(limit),
    });
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
