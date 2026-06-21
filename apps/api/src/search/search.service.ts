import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import type { MultiSearchParams } from 'meilisearch';
import type { SearchDocument } from './search.documents';
import { reindexIndex, type ReindexClient } from './reindex';
import {
  FolderAccessService,
  folderVisible,
  type VisibleFolders,
} from '../article-categories/folder-access.service';
import type { Principal } from '../auth/principal';

/** The five Meili indexes (one per searchable entity). Primary key on every index is `id`. */
export const SEARCH_INDEXES = [
  'assets',
  'articles',
  'users',
  'locations',
  'applications',
] as const;

export type SearchIndex = (typeof SEARCH_INDEXES)[number];

/**
 * What each index is allowed to **return** in a hit — pinned to the shared `*HitSchema` (the wire
 * contract). The indexed (searchable) surface is wider than this: articles index the full markdown
 * `content` so runbook bodies are findable (ADR-0042), but `content` is deliberately NOT retrievable
 * (SEC-061) — full-text matching over it stays intact, the blob just never ships in the response.
 * Retrieval ≠ searchability in Meili. Keep this in lockstep with the `*HitSchema` in @lazyit/shared.
 */
const RETRIEVE: Record<SearchIndex, string[]> = {
  assets: ['id', 'name', 'serial', 'assetTag', 'status', 'notes'],
  // `categoryId` (the home folder) is retrieved INTERNALLY for the ADR-0060 §5 folder-access
  // post-filter, then STRIPPED from the hit before it ships (it is access metadata, not a hit field —
  // the wire ArticleHit has no categoryId). `content` is indexed but never returned (SEC-061).
  articles: ['id', 'slug', 'title', 'excerpt', 'status', 'categoryId'],
  users: ['id', 'firstName', 'lastName', 'email'],
  locations: ['id', 'name', 'type', 'address', 'floor'],
  applications: ['id', 'name', 'vendor', 'description'],
};

/** The internal-only article-hit field stripped before a hit ships (the post-filter's folder key). */
const ARTICLE_INTERNAL_FIELD = 'categoryId';

/**
 * Build the Meili-side article folder filter (#598, ADR-0060 §5). Pins the article query to the caller's
 * visible home folders so readable hits ranking below the naive `limit` window are no longer dropped:
 *
 *  - ADMIN (`'ALL'`) → `undefined`: no filter, every article is in scope (§5).
 *  - any other caller → `categoryId IN ['f1','f2',...]` over their visible set.
 *  - an EMPTY visible set → a never-match filter (`categoryId IN []` is invalid in Meili), so a fully-
 *    restricted caller gets ZERO article hits — fail closed, never match-all.
 *
 * Folder ids are quoted so a value can never break the filter expression (cuids are alnum, but the quote
 * is defensive). The in-app post-filter remains the authoritative authz backstop on top of this (INV-9).
 */
export function articleFolderFilter(
  visible: VisibleFolders,
): string | undefined {
  if (visible === 'ALL') return undefined;
  const ids = [...visible];
  if (ids.length === 0) {
    // `categoryId IN []` is a syntax error in Meili; an existence check that can never hold matches no
    // document, which is exactly the fail-closed semantics we want for a caller with no visible folders.
    return 'categoryId IS NULL AND categoryId IS NOT NULL';
  }
  const quoted = ids.map((id) => `'${id.replace(/'/g, "\\'")}'`).join(', ');
  return `categoryId IN [${quoted}]`;
}

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
  /**
   * The caller's unified PRINCIPAL (ADR-0060 §5). Drives the article folder-access post-filter: ADMIN
   * sees every hit (§5), a non-admin only hits whose home folder they may see, a service account fails
   * closed on restricted folders (§8). Omitted = anonymous → only PUBLIC-folder article hits.
   */
  principal?: Principal;
}

/**
 * The cross-entity search response: one `{ hits, total }` block per requested entity, plus an
 * optional `degraded` outage flag (issue #370). `degraded` is `true` only when Meili was configured
 * but the read failed and we fell back to empty blocks — it lets the client tell a transient engine
 * outage apart from a genuine "no results". Omitted (= not degraded) on every healthy response.
 */
export type SearchResults = Partial<Record<SearchIndex, SearchEntityResult>> & {
  degraded?: boolean;
};

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
    // ADR-0060 §5: the read-path folder-access evaluator, used to post-filter article hits so a
    // restricted article never surfaces to a non-matching caller (INV-9, the search-leak fix).
    private readonly folderAccess: FolderAccessService,
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
   *
   * NOTE (ADR-0069 §10): there is NO process-wide write suppression here. The bulk migrator commit
   * suppresses ONLY its own per-row asset upserts via `AssetsService.create({ suppressSearch: true })`
   * and runs one post-bulk reconcile — so a concurrent non-import write is never silently dropped.
   */
  upsert(index: SearchIndex, doc: SearchDocument): void {
    if (!this.client) return;
    this.client
      .index(index)
      .addDocuments([doc], { primaryKey: 'id' })
      .catch((err: unknown) => {
        // A dropped sync leaves this row stale/unsearchable until its next write or a `reindex:all`
        // (issue #370). Log it loudly with index + id so the gap is diagnosable from the logs.
        this.logger.error(
          { err, index, id: doc.id, op: 'upsert' },
          'Dropped Meilisearch sync: failed to index document (row stale until next write or reindex)',
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
        // A dropped removal leaves a GHOST document searchable until a `reindex:all` evicts it
        // (issue #370 / ghost-doc note in reindex.ts). Log it loudly with index + id.
        this.logger.error(
          { err, index, id, op: 'remove' },
          'Dropped Meilisearch sync: failed to remove document (ghost remains until reindex)',
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
  async search({
    q,
    entities,
    limit,
    principal,
  }: SearchArgs): Promise<SearchResults> {
    const requested: SearchIndex[] =
      entities && entities.length > 0 ? entities : [...SEARCH_INDEXES];

    if (!this.client) {
      return this.emptyResults(requested);
    }

    // ADR-0060 §5 (#598): resolve the caller's visible folders ONCE, up front, when articles are in
    // scope — used BOTH to push a Meili-side `categoryId IN [...]` filter into the article query (so
    // readable hits that rank below the naive `limit` window are no longer silently dropped) AND, as a
    // defense-in-depth backstop, by the in-app post-filter below (INV-9 — never rely on Meili for authz;
    // the index can lag a just-revoked grant, the live evaluator is authoritative).
    const articleVisible = requested.includes('articles')
      ? await this.folderAccess.visibleFolderIds(principal)
      : undefined;

    const params: MultiSearchParams = {
      queries: requested.map((indexUid) => {
        const query: MultiSearchParams['queries'][number] = {
          indexUid,
          q,
          limit,
          // cap the per-hit payload to the documented hit fields (SEC-061). For articles this includes
          // the internal `categoryId` (the folder-access post-filter key), stripped before shipping.
          attributesToRetrieve: RETRIEVE[indexUid],
        };
        // Meili-side folder scoping (#598): pin the article query to the caller's visible folders.
        // ADMIN ('ALL') gets no filter (sees everything, §5); any other caller gets a `categoryId IN`
        // filter (an empty visible set yields a never-match, so a fully-restricted caller gets 0 hits).
        if (indexUid === 'articles' && articleVisible !== undefined) {
          const filter = articleFolderFilter(articleVisible);
          if (filter !== undefined) query.filter = filter;
        }
        return query;
      }),
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
      // ADR-0060 §5 (INV-9): the search-leak BACKSTOP. The Meili-side `categoryId IN` filter above
      // already scopes the article query, so `total` is the engine's count of READABLE matches (#598).
      // We STILL re-run the §4 evaluator in-app and DROP any hit whose home folder the caller may not
      // see — defense in depth: the index is a denormalized cache that can lag a just-revoked grant, so
      // we never trust Meili alone for authz. Reuses the `articleVisible` resolved up front (no second
      // DB walk). A drop here means index lag; `total` is decremented per dropped hit to stay honest.
      if (articleVisible !== undefined) {
        this.applyArticleFolderFilter(results, articleVisible);
      }
      return results;
    } catch (err: unknown) {
      // Fail-soft (ADR-0035): a configured-but-unhealthy engine returns empty results, never a 500.
      // But mark the envelope `degraded: true` (issue #370) so the client can tell a transient outage
      // apart from a genuine empty result and show "search unavailable" instead of "no results".
      this.logger.error(
        { err, entities: requested, q, limit },
        'Meilisearch multiSearch failed — returning empty search results (degraded, fail-soft)',
      );
      const degraded = this.emptyResults(requested);
      degraded.degraded = true;
      return degraded;
    }
  }

  /**
   * The indexes that are **missing or empty** right now (issue #370 self-heal). Asks Meili once for
   * its per-index stats: an index absent from the stats map has never been created, and one with
   * `numberOfDocuments === 0` is empty — both need a (re)build. Returns `[]` in disabled mode or if the
   * stats call fails (we never want index-health probing to crash boot — the caller logs and moves on).
   */
  async emptyOrMissingIndexes(): Promise<SearchIndex[]> {
    if (!this.client) return [];
    const stats = await this.client.getStats();
    const byIndex = stats.indexes ?? {};
    return SEARCH_INDEXES.filter((index) => {
      const indexStats = byIndex[index];
      // Missing from the map = never created; present with 0 docs = empty. Either way, rebuild it.
      return indexStats === undefined || indexStats.numberOfDocuments === 0;
    });
  }

  /**
   * Authoritatively (re)build one index from its full live `docs` set (issue #370 self-heal), reusing
   * the zero-downtime temp-index-swap of {@link reindexIndex}. No-op in disabled mode. The Meili client
   * structurally satisfies the small {@link ReindexClient} surface the rebuild needs.
   */
  async rebuildIndex(index: SearchIndex, docs: SearchDocument[]): Promise<void> {
    if (!this.client) return;
    await reindexIndex(this.client as unknown as ReindexClient, index, docs);
  }

  /**
   * The ADR-0060 §5 article folder-access in-app BACKSTOP (INV-9 — defense in depth over the Meili-side
   * filter, #598). Mutates the `articles` block in place over the ALREADY-RESOLVED `visible` set (no DB
   * walk here — the caller resolves it once and shares it with the Meili filter): DROP every hit whose
   * `categoryId` (home folder) is not visible, and STRIP the internal `categoryId` from each surviving
   * hit so it never ships to the client. ADMIN ('ALL') keeps every hit; an SA / anonymous keeps only
   * PUBLIC-folder hits.
   *
   * `total` is the engine's count of the (already folder-filtered) readable matches (#598) — preserved,
   * NOT clobbered to the page size. It is only DECREMENTED per hit this backstop drops (a drop means the
   * index lagged a just-revoked grant), so the count never overstates what the caller may actually read.
   *
   * A hit missing its `categoryId` (a stale doc indexed before this field landed) is DROPPED for a
   * non-admin — fail closed: better to under-return than leak a restricted article whose folder we
   * can't resolve.
   */
  private applyArticleFolderFilter(
    results: SearchResults,
    visible: VisibleFolders,
  ): void {
    const block = results.articles;
    if (block === undefined || block.hits.length === 0) return;

    const kept: unknown[] = [];
    let dropped = 0;
    for (const hit of block.hits) {
      const record = hit as Record<string, unknown>;
      const categoryId = record[ARTICLE_INTERNAL_FIELD];
      const allowed =
        visible === 'ALL' ||
        (typeof categoryId === 'string' && folderVisible(visible, categoryId));
      if (!allowed) {
        dropped += 1;
        continue;
      }
      // Strip the internal folder key — the wire ArticleHit carries no categoryId.
      const { [ARTICLE_INTERNAL_FIELD]: _omit, ...shipped } = record;
      void _omit;
      kept.push(shipped);
    }
    // Preserve the engine's filtered total (#598); only subtract what the backstop actually dropped.
    results.articles = {
      hits: kept,
      total: Math.max(0, block.total - dropped),
    };
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
