import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import type { MultiSearchParams } from 'meilisearch';
import type { SearchDocument } from './search.documents';

/** The five Meili indexes (one per searchable entity). Primary key on every index is `id`. */
export const SEARCH_INDEXES = [
  'assets',
  'articles',
  'users',
  'locations',
  'applications',
] as const;

export type SearchIndex = (typeof SEARCH_INDEXES)[number];

/** Per-index result block returned to the caller: the raw hits and Meili's total estimate. */
export interface SearchEntityResult {
  hits: unknown[];
  total: number;
}

/** Arguments for a cross-entity search. */
export interface SearchArgs {
  /** The query string (empty string is valid — returns top documents per index). */
  q: string;
  /** Which indexes to search; defaults to all five when omitted/empty. */
  entities?: SearchIndex[];
  /** Per-index hit cap (1..50, defaulted by the controller). */
  limit: number;
}

/** The cross-entity search response: one `{ hits, total }` block per requested entity. */
export type SearchResults = Record<SearchIndex, SearchEntityResult>;

/**
 * Cross-cutting search backed by Meilisearch (ADR-0035).
 *
 * Configured from `MEILI_HOST` / `MEILI_MASTER_KEY`. When `MEILI_HOST` is unset/empty the service
 * runs in **disabled mode**: every method is a safe no-op and {@link search} returns empty blocks —
 * the app works without a search engine (fail-soft).
 *
 * Writes ({@link upsert} / {@link remove}) are **fire-and-forget**: callers invoke them un-awaited,
 * they never throw, and any engine error is caught and logged (CRITICAL) so a search outage cannot
 * fail a domain write. Reads ({@link search}) use Meili's `multiSearch` across the requested indexes.
 */
@Injectable()
export class SearchService {
  private readonly client: Meilisearch | undefined;

  constructor(
    @InjectPinoLogger(SearchService.name)
    private readonly logger: PinoLogger,
  ) {
    const host = process.env.MEILI_HOST;
    const apiKey = process.env.MEILI_MASTER_KEY;
    if (host) {
      this.client = new Meilisearch({ host, apiKey });
    } else {
      this.client = undefined;
      this.logger.info(
        'MEILI_HOST is not set — search is disabled (sync no-ops, /search returns empty results)',
      );
    }
  }

  /** True when a Meili client is configured; false in disabled mode. */
  get enabled(): boolean {
    return this.client !== undefined;
  }

  /**
   * Add or replace a document in an index (Meili upsert by primary key). Fire-and-forget: returns
   * immediately, never throws, and logs (CRITICAL) on failure. No-op when disabled.
   */
  upsert(index: SearchIndex, doc: SearchDocument): void {
    if (!this.client) return;
    this.client
      .index(index)
      .addDocuments([doc], { primaryKey: 'id' })
      .catch((err: unknown) => {
        this.logger.error(
          { err, index, id: doc.id },
          'Failed to index document in Meilisearch',
        );
      });
  }

  /**
   * Remove a document from an index by id (e.g. on soft-delete). Fire-and-forget: returns
   * immediately, never throws, and logs (CRITICAL) on failure. No-op when disabled.
   */
  remove(index: SearchIndex, id: string): void {
    if (!this.client) return;
    this.client
      .index(index)
      .deleteDocument(id)
      .catch((err: unknown) => {
        this.logger.error(
          { err, index, id },
          'Failed to remove document from Meilisearch',
        );
      });
  }

  /**
   * Cross-entity search via Meili `multiSearch`. Searches the requested `entities` (defaults to all
   * five) and returns one `{ hits, total }` block per requested entity. In disabled mode every
   * requested entity gets an empty block (no engine call).
   *
   * **Fail-soft (ADR-0035):** reads mirror the write-side posture — if Meili is configured but
   * currently unreachable / rejecting (the engine went down or the key was revoked after
   * construction), the rejected `multiSearch` is caught, logged (error), and the call resolves to
   * empty blocks instead of bubbling a 500. A search outage degrades search; it never takes the app
   * down.
   */
  async search({ q, entities, limit }: SearchArgs): Promise<SearchResults> {
    const requested: SearchIndex[] =
      entities && entities.length > 0 ? entities : [...SEARCH_INDEXES];

    if (!this.client) {
      return this.emptyResults(requested);
    }

    const params: MultiSearchParams = {
      queries: requested.map((indexUid) => ({ indexUid, q, limit })),
    };

    try {
      const response = await this.client.multiSearch(params);

      // Start from empty blocks for every requested index so a missing result (or a per-index error
      // surfaced as a skipped result) still yields a well-formed, empty block rather than undefined.
      const results = this.emptyResults(requested);
      for (const result of response.results) {
        const index = result.indexUid as SearchIndex;
        if (!requested.includes(index)) continue;
        results[index] = {
          hits: result.hits,
          // `estimatedTotalHits` is Meili's count for the (default, infinite-pagination) query; fall
          // back to the number of returned hits if the engine omits it.
          total: result.estimatedTotalHits ?? result.hits.length,
        };
      }
      return results;
    } catch (err: unknown) {
      // Fail-soft (ADR-0035): a configured-but-unhealthy engine returns empty results, never a 500.
      this.logger.error(
        { err, entities: requested, q, limit },
        'Meilisearch multiSearch failed — returning empty search results (fail-soft)',
      );
      return this.emptyResults(requested);
    }
  }

  /** A `{ hits: [], total: 0 }` block for each requested index (disabled mode / seed for search). */
  private emptyResults(requested: SearchIndex[]): SearchResults {
    const results = {} as SearchResults;
    for (const index of requested) {
      results[index] = { hits: [], total: 0 };
    }
    return results;
  }
}
