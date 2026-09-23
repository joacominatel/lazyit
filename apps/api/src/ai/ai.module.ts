import { Module } from '@nestjs/common';
import { AiCoreModule } from './core/ai-core.module';
import { AiConversationsModule } from './conversations/ai-conversations.module';
import { AiHeadlessModule } from './headless/ai-headless.module';
import { AiPromptModule } from './prompt/ai-prompt.module';
import { AiProvidersModule } from './providers/ai-providers.module';
import { AiRetentionModule } from './retention/ai-retention.module';
import { AiRunsModule } from './runs/ai-runs.module';
import { AiRuntimeModule } from './runtime/ai-runtime.module';
import { AiSettingsModule } from './settings/ai-settings.module';
import { AiStatusModule } from './status/ai-status.module';

/**
 * The AI assistant (ADR-0097; docs/ai-assistant/_synthesis.md §5): the tool core plus one submodule per
 * concern, each owned by its own implementation unit. Every submodule is wired here once, so the units
 * never touch this file or `app.module.ts`.
 *
 * Off by default: with no `ai_settings` row the capability is disabled, and none of this changes what an
 * existing instance serves until an admin enables it.
 */
@Module({
  imports: [
    AiCoreModule,
    AiProvidersModule,
    AiRuntimeModule,
    AiPromptModule,
    AiSettingsModule,
    AiStatusModule,
    AiConversationsModule,
    AiRunsModule,
    AiHeadlessModule,
    AiRetentionModule,
  ],
  exports: [AiCoreModule],
})
export class AiModule {}
