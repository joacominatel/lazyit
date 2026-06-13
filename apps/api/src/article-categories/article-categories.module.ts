import { Module } from '@nestjs/common';
import { ArticleCategoriesController } from './article-categories.controller';
import { ArticleCategoriesService } from './article-categories.service';
import { FolderAccessService } from './folder-access.service';

@Module({
  controllers: [ArticleCategoriesController],
  // FolderAccessService (ADR-0060 §4) is the read-path folder-access evaluator. Exported so the
  // Articles module (read gate / search post-filter) and Search module can resolve a caller's visible
  // folders. It only depends on the global PrismaService.
  providers: [ArticleCategoriesService, FolderAccessService],
  exports: [ArticleCategoriesService, FolderAccessService],
})
export class ArticleCategoriesModule {}
