import { Module } from '@nestjs/common';

/**
 * The retention sweeper that purges transcripts past `retentionDays` (the ledgers are never pruned).
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W3-6 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiRetentionModule {}
