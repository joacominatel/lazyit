import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectLocation,
  projectUser,
  type SearchDocument,
} from './search.documents';
import { SearchService, type SearchIndex } from './search.service';

/**
 * Boot-time search self-heal (issue #370). A freshly-seeded database leaves the five Meili indexes
 * empty (the seed never indexes; `reindex:all` is a manual step), so search silently returns nothing
 * until an operator remembers to reindex. This guard closes that gap WITHOUT making it unsafe on a
 * populated prod DB:
 *
 * - On boot it asks Meili which indexes are **missing or empty** ({@link SearchService.emptyOrMissingIndexes})
 *   and rebuilds only those, in the BACKGROUND. It is a strict **no-op when every index already has
 *   documents** — so on a large prod DB there is nothing to lose and nothing happens.
 * - It runs `onApplicationBootstrap` un-awaited (fire-and-forget), so it NEVER blocks boot/readiness:
 *   the app is serving requests while any rebuild proceeds. A rebuild uses the same zero-downtime
 *   temp-index-swap as `reindex:all` ({@link SearchService.rebuildIndex} → `reindexIndex`).
 * - It is a no-op in search-disabled mode (no `MEILI_HOST`) and under `NODE_ENV=test` (the Jest suite
 *   has no real Meili/DB), and any failure is caught and logged — index-health probing must never
 *   crash the API.
 *
 * The live set mirrors the read-path / `reindex:all` visibility exactly: soft-deleted rows are excluded
 * (`deletedAt: null`) and only PUBLISHED articles are indexed (draft privacy — ADR-0022/0035).
 */
@Injectable()
export class SearchBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SearchBootstrapService.name);

  constructor(
    private readonly search: SearchService,
    private readonly prisma: PrismaService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    if (!this.search.enabled) {
      return;
    }
    // Fire-and-forget: do NOT await — boot/readiness must not wait on a (potentially large) rebuild.
    void this.selfHeal();
  }

  /**
   * One self-heal pass: find the missing/empty indexes and rebuild each from the live DB set. Public so
   * a test or operator can trigger it directly. The whole pass is try/caught so a transient Meili/DB
   * error never escapes the background task. Returns the indexes it (attempted to) rebuild.
   */
  async selfHeal(): Promise<SearchIndex[]> {
    try {
      const stale = await this.search.emptyOrMissingIndexes();
      if (stale.length === 0) {
        // Every index already has documents — nothing to do (the safe, common prod path).
        return [];
      }
      this.logger.log(
        `Search self-heal: ${stale.length} empty/missing index(es) [${stale.join(', ')}] — rebuilding in the background.`,
      );
      for (const index of stale) {
        await this.rebuild(index);
      }
      return stale;
    } catch (err) {
      this.logger.error(
        `Search self-heal failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  /** Load the live set for one index and rebuild it (zero-downtime). Errors are logged, not thrown. */
  private async rebuild(index: SearchIndex): Promise<void> {
    try {
      const docs = await this.loadDocs(index);
      await this.search.rebuildIndex(index, docs);
      this.logger.log(
        `Search self-heal: rebuilt '${index}' with ${docs.length} document(s).`,
      );
    } catch (err) {
      this.logger.error(
        `Search self-heal: failed to rebuild '${index}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * The live, indexable document set for one index — same visibility the read path and `reindex:all`
   * enforce (soft-deleted excluded; only PUBLISHED articles).
   */
  private async loadDocs(index: SearchIndex): Promise<SearchDocument[]> {
    switch (index) {
      case 'assets': {
        const rows = await this.prisma.asset.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectAsset);
      }
      case 'articles': {
        // Draft privacy (ADR-0022/0035): only PUBLISHED articles are searchable.
        const rows = await this.prisma.article.findMany({
          where: { deletedAt: null, status: 'PUBLISHED' },
        });
        return rows.map(projectArticle);
      }
      case 'users': {
        const rows = await this.prisma.user.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectUser);
      }
      case 'locations': {
        const rows = await this.prisma.location.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectLocation);
      }
      case 'applications': {
        const rows = await this.prisma.application.findMany({
          where: { deletedAt: null },
        });
        return rows.map(projectApplication);
      }
    }
  }
}
