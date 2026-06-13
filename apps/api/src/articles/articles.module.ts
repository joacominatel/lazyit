import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { ArticleImportService } from './import/article-import.service';
import { ArticleCategoriesModule } from '../article-categories/article-categories.module';
import {
  ARTICLE_IMPORT_QUEUE,
  importChildHeapMb,
  importProcessorPath,
} from './import/import-job.constants';

@Module({
  imports: [
    // ADR-0060 §4: the read path injects FolderAccessService (exported by ArticleCategoriesModule) to
    // gate article reads / the search post-filter by the caller's visible folders.
    ArticleCategoriesModule,
    // Async article import (ADR-0053). The `.docx` parse runs in a BullMQ SANDBOXED processor: a
    // forked Node child launched with `--max-old-space-size`, so a decompression bomb OOMs the child
    // (BullMQ marks the job failed) and never the API process (SEC-002). md/txt flow through the same
    // queue for a uniform async UX. Concurrency 1 keeps memory pressure bounded.
    BullModule.registerQueue({
      name: ARTICLE_IMPORT_QUEUE,
      processors: [
        {
          path: importProcessorPath(),
          concurrency: 1,
          workerForkOptions: {
            execArgv: [`--max-old-space-size=${importChildHeapMb()}`],
          },
        },
      ],
    }),
  ],
  controllers: [ArticlesController],
  providers: [ArticlesService, ArticleImportService],
  exports: [ArticlesService],
})
export class ArticlesModule {}
