import { Module } from '@nestjs/common';

/**
 * `GET /ai/status` — what the web shell gates the chat launcher on.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W2-2 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiStatusModule {}
