import { Module } from '@nestjs/common';

/**
 * The AI configuration: `/config/ai`, the enable gate and disclosure, the configuration audit, the connection tester and the `AiSettingsReader` implementation.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W2-2 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiSettingsModule {}
