import { Module } from '@nestjs/common';
import { AiCoreModule } from '../core/ai-core.module';
import { AiRetentionModule } from '../retention/ai-retention.module';
import { AiRuntimeModule } from '../runtime/ai-runtime.module';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiConversationsController } from './ai-conversations.controller';
import { AiConversationsService } from './ai-conversations.service';

/**
 * `/ai/conversations` — the in-app chat's conversations (ADR-0097; synthesis §4.7; W3-1): create, list,
 * read (the provider-neutral projection), delete (the retention unit's purge service, W3-6), and send a
 * message (→ a run of the runtime).
 *
 * Imports the runtime for its orchestrator, the tool core for the registry (the class of a projected
 * call), the settings reader and the retention module for the purge service. PrismaService and the auth guards are global.
 */
@Module({
  imports: [AiRuntimeModule, AiCoreModule, AiSettingsModule, AiRetentionModule],
  controllers: [AiConversationsController],
  providers: [AiConversationsService],
})
export class AiConversationsModule {}
