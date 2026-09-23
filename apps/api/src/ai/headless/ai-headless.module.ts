import { Module } from '@nestjs/common';

/**
 * The per-Service-Account AI access setting and `/config/ai/service-accounts/:id`.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W3-1 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiHeadlessModule {}
