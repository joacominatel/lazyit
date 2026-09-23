import { Module } from '@nestjs/common';

/**
 * `/ai/runs` — run creation (chat and headless), the SSE event stream, cancel and the approval decision endpoint.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W3-1 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiRunsModule {}
