import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ArticlesModule } from '../articles/articles.module';
import { AttachmentsService } from './attachments.service';
import { AttachmentsGcService } from './attachments-gc.service';
import { AttachmentsGcWorker } from './attachments-gc.worker';
import { AssetAttachmentsController } from './asset-attachments.controller';
import { ArticleAttachmentsController } from './article-attachments.controller';
import { PurchaseOrderAttachmentsController } from './purchase-order-attachments.controller';
import {
  ATTACHMENT_REENCODE_QUEUE,
  ATTACHMENTS_GC_QUEUE,
  reencodeChildHeapMb,
  reencodeProcessorPath,
} from './attachments.constants';

/**
 * File attachments (ADR-0082, issue #906): asset documents, KB inline images and purchase documents
 * (ADR-0099 §10, #1473). Thin per-parent controllers over one service; the parent's authz is the whole
 * authz (ArticlesModule exports the article gate). Two queues: the SANDBOXED sharp re-encode (a forked, heap-capped child — the
 * article-import SEC-002 mold) and the daily GC sweep (an in-process worker on a repeatable job).
 */
@Module({
  imports: [
    ArticlesModule,
    BullModule.registerQueue({
      name: ATTACHMENT_REENCODE_QUEUE,
      processors: [
        {
          path: reencodeProcessorPath(),
          concurrency: 1,
          workerForkOptions: {
            execArgv: [`--max-old-space-size=${reencodeChildHeapMb()}`],
          },
        },
      ],
    }),
    BullModule.registerQueue({ name: ATTACHMENTS_GC_QUEUE }),
  ],
  controllers: [
    AssetAttachmentsController,
    ArticleAttachmentsController,
    PurchaseOrderAttachmentsController,
  ],
  providers: [AttachmentsService, AttachmentsGcService, AttachmentsGcWorker],
})
export class AttachmentsModule {}
