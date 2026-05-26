import { Global, Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Cross-cutting search (ADR-0035). Global so every feature service can inject {@link SearchService}
 * to fire-and-forget index sync without an explicit per-module import. Hosts the `GET /search`
 * endpoint. When `MEILI_HOST` is unset the service runs in disabled mode (sync no-ops, search empty).
 */
@Global()
@Module({
  providers: [SearchService],
  exports: [SearchService],
  controllers: [SearchController],
})
export class SearchModule {}
