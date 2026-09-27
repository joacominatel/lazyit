import { Module } from '@nestjs/common';
import { EnvelopeCipher } from '../../common/crypto/envelope-cipher';
import { AI_SETTINGS_READER } from '../core/ports/ai-settings.port';
import { AiConnectionTester } from './ai-connection-tester';
import { AiSettingsController } from './ai-settings.controller';
import {
  AI_PROVIDER_KEY_PURPOSE,
  AI_SECRET_KEY_ENV,
} from './ai-settings.constants';
import { AI_SECRET_CIPHER, AiSettingsService } from './ai-settings.service';

/**
 * The AI configuration (ADR-0097 decision 7; synthesis §5, §10 unit W2-2): `/config/ai` (read, save, the
 * enable gate and the egress disclosure, the connection test, model suggestions), the redacted config
 * audit, and the {@link AI_SETTINGS_READER} every other AI unit reads the settings through.
 *
 * It does NOT import `AiProvidersModule`: the provider layer imports this module for the reader, and the
 * connection tester resolves `CHAT_MODEL_PORT` lazily instead, so there is no module cycle.
 * PrismaService (global PrismaModule) injects without an import.
 */
@Module({
  controllers: [AiSettingsController],
  providers: [
    {
      provide: AI_SECRET_CIPHER,
      useFactory: () =>
        new EnvelopeCipher(AI_SECRET_KEY_ENV, AI_PROVIDER_KEY_PURPOSE),
    },
    AiConnectionTester,
    AiSettingsService,
    { provide: AI_SETTINGS_READER, useExisting: AiSettingsService },
  ],
  exports: [AI_SETTINGS_READER, AiSettingsService],
})
export class AiSettingsModule {}
