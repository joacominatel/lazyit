import { Module } from '@nestjs/common';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AiStatusController } from './ai-status.controller';
import { AiStatusService } from './ai-status.service';

/**
 * `GET /ai/status` — what the web shell gates the chat launcher on (synthesis §4.5). Reads the settings
 * through `AI_SETTINGS_READER` (AiSettingsModule); PermissionResolverService comes from the global
 * AuthModule.
 */
@Module({
  imports: [AiSettingsModule],
  controllers: [AiStatusController],
  providers: [AiStatusService],
})
export class AiStatusModule {}
