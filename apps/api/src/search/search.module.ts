import { Global, Module } from '@nestjs/common';
import { SearchBootstrapService } from './search-bootstrap.service';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import { ArticleCategoriesModule } from '../article-categories/article-categories.module';

/**
 * Cross-cutting search (ADR-0035). Global so every feature service can inject {@link SearchService}
 * to fire-and-forget index sync without an explicit per-module import. Hosts the `GET /search`
 * endpoint. When `MEILI_HOST` is unset the service runs in disabled mode (sync no-ops, search empty).
 *
 * {@link SearchBootstrapService} runs a boot-time, background, no-op-when-populated self-heal of empty
 * Meili indexes (issue #370) — it injects the (global) PrismaService, so no extra module import.
 *
 * Imports {@link ArticleCategoriesModule} for the FolderAccessService — the ADR-0060 §5 article search
 * post-filter (INV-9) that drops a restricted article hit from a non-matching caller's results.
 */
@Global()
@Module({
  imports: [ArticleCategoriesModule],
  providers: [SearchService, SearchBootstrapService],
  exports: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}
