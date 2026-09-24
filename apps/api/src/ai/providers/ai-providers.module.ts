import { Module } from '@nestjs/common';

import { CHAT_MODEL_PORT } from '../core/ports/chat-model.port';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiModelListService } from './ai-model-list.service';
import { AiSdkChatModel } from './aisdk-chat-model';

/**
 * The LLM provider layer (ADR-0097 decision 5; docs/ai-assistant/provider-and-runtime.md §6): the
 * `ChatModelPort` implementation over AI SDK 7 and one definition per provider. The only code that
 * imports `ai` / `@ai-sdk/*` (`sdk-import-boundary.spec.ts` enforces it).
 *
 * Imports `AiSettingsModule` for `AI_SETTINGS_READER`. The settings module does not import this one — its
 * connection tester resolves `CHAT_MODEL_PORT` lazily — so there is no module cycle.
 *
 * Exports:
 * - `CHAT_MODEL_PORT` — one model step per call, for the runtime and the connection tester;
 * - `AiModelListService` — model suggestions for a draft connection.
 */
@Module({
  imports: [AiSettingsModule],
  providers: [
    AiSdkChatModel,
    { provide: CHAT_MODEL_PORT, useExisting: AiSdkChatModel },
    AiModelListService,
  ],
  exports: [CHAT_MODEL_PORT, AiModelListService],
})
export class AiProvidersModule {}
