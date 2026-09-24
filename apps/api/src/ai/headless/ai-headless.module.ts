import { Module } from '@nestjs/common';
import { AiServiceAccountAccessController } from './ai-service-account-access.controller';
import { AiServiceAccountAccessService } from './ai-service-account-access.service';

/**
 * The per-Service-Account AI access setting and `/config/ai/service-accounts/:id` (ADR-0097 decision 4;
 * synthesis §4.7; W3-1). The headless run itself is `POST /ai/runs` (`AiRunsModule`): the channel follows
 * the principal, and the runtime enforces this setting and the `infra:report` refusal before every step.
 * PrismaService and the auth guards are global.
 */
@Module({
  controllers: [AiServiceAccountAccessController],
  providers: [AiServiceAccountAccessService],
})
export class AiHeadlessModule {}
