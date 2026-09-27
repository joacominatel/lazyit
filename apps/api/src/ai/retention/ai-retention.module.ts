import { Module } from '@nestjs/common';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiConversationPurgeService } from './ai-conversation-purge.service';
import { AiRetentionSweeper } from './ai-retention.sweeper';

/**
 * Transcript retention (ADR-0097 decision 11; provider-and-runtime.md §7; synthesis §5, §10 unit W3-6):
 * the hourly sweeper and {@link AiConversationPurgeService}, the only deleter of AI conversations — past
 * retention, on the owner's request, and on offboarding. The ledgers (`AiActionLog`, `AiRun`, `AiUsage`)
 * are never pruned.
 *
 * Exports the purge service for the conversations endpoint (W3-1, `DELETE /ai/conversations/:id`) and for
 * an offboarding caller. Reads the window through `AI_SETTINGS_READER`; `PrismaService` is global.
 */
@Module({
  imports: [AiSettingsModule],
  providers: [AiConversationPurgeService, AiRetentionSweeper],
  exports: [AiConversationPurgeService],
})
export class AiRetentionModule {}
