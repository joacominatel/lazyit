import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import type { MultiSearchParams } from 'meilisearch';
import type { SearchDocument } from './search.documents';
import { reindexIndex, type ReindexClient } from './reindex';
import {
  FolderAccessService,
  folderVisible,
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

  /**
   * Side-effect suppression depth (ADR-0069 §10). A bulk operation (the migrator commit) brackets its
   * run with {@link runSuppressed} so the thousands of per-row `create()` calls don't each fire a Meili
   * `upsert`/`remove` — the writes are dropped while the depth is > 0, and the caller runs ONE post-bulk
   * {@link rebuildIndex} reconcile instead. A counter (not a boolean) keeps nested brackets safe; reads
   * ({@link search}) are NEVER suppressed, only writes.
   */
  private suppressDepth = 0;

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
   * Run `fn` with per-document search writes SUPPRESSED (ADR-0069 §10 — bulk import side-effect policy).
   * While the returned promise is in flight, {@link upsert}/{@link remove} are no-ops; the caller is
   * responsible for one post-bulk {@link rebuildIndex} reconcile. The depth counter is decremented in a
   * `finally` so a throw inside `fn` never leaves writes permanently muted. Reads are unaffected.
   */
  async runSuppressed<T>(fn: () => Promise<T>): Promise<T> {
    this.suppressDepth += 1;
    try {
      return await fn();
    } finally {
      this.suppressDepth -= 1;
    }
  }

  /**
   * Add or replace a document in an index (Meili upsert by primary key). Fire-and-forget: returns
   * immediately, never throws, and logs (CRITICAL) on failure. No-op when disabled.
   */
  upsert(index: SearchIndex, doc: SearchDocument): void {
    if (!this.client || this.suppressDepth > 0) return;
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
    if (!this.client || this.suppressDepth > 0) return;
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

    const params: MultiSearchParams = {
      queries: requested.map((indexUid) => ({
        indexUid,
        q,
        limit,
        // cap the per-hit payload to the documented hit fields (SEC-061). For articles this includes
        // the internal `categoryId` (the folder-access post-filter key), stripped before shipping.
        attributesToRetrieve: RETRIEVE[indexUid],
      })),
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
      // ADR-0060 §5 (INV-9): the search-leak fix. Re-run the §4 folder-access evaluator and DROP any
      // article hit whose home folder the caller may not see, so a restricted article NEVER surfaces to
      // a non-matching caller (ADMIN sees all; SA fails closed; anonymous → PUBLIC only). Done AFTER the
      // Meili read because access is DB-first (the index is a denormalized cache that can lag a just-
      // revoked grant; the live evaluator is authoritative).
      if (requested.includes('articles')) {
        await this.applyArticleFolderFilter(results, principal);
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
   * The ADR-0060 §5 article folder-access post-filter (INV-9 — closes the search leak). Mutates the
   * `articles` block in place: resolve the caller's visible folders DB-first, DROP every hit whose
   * `categoryId` (home folder) is not visible, and STRIP the internal `categoryId` from each surviving
   * hit so it never ships to the client. `total` is re-counted to the kept hits so the UI count matches
   * what it can see. ADMIN ('ALL') keeps every hit; an SA / anonymous keeps only PUBLIC-folder hits.
   *
   * A hit missing its `categoryId` (a stale doc indexed before this field landed) is DROPPED for a
   * non-admin — fail closed: better to under-return than leak a restricted article whose folder we
   * can't resolve.
   */
  private async applyArticleFolderFilter(
    results: SearchResults,
    principal?: Principal,
  ): Promise<void> {
    const block = results.articles;
    if (block === undefined || block.hits.length === 0) return;

    const visible = await this.folderAccess.visibleFolderIds(principal);
    const kept: unknown[] = [];
    for (const hit of block.hits) {
      const record = hit as Record<string, unknown>;
      const categoryId = record[ARTICLE_INTERNAL_FIELD];
      const allowed =
        visible === 'ALL' ||
        (typeof categoryId === 'string' && folderVisible(visible, categoryId));
      if (!allowed) continue;
      // Strip the internal folder key — the wire ArticleHit carries no categoryId.
      const { [ARTICLE_INTERNAL_FIELD]: _omit, ...shipped } = record;
      void _omit;
      kept.push(shipped);
    }
    results.articles = { hits: kept, total: kept.length };
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
