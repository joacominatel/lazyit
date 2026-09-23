import { Module } from '@nestjs/common';

/**
 * `/ai/conversations` — the in-app chat's conversations.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W3-1 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiConversationsModule {}
