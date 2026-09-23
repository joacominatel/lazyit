import { Module } from '@nestjs/common';

/**
 * The LLM provider layer: the `ChatModelPort` implementation over AI SDK 7 and one definition per provider. The only code that imports `ai` / `@ai-sdk/*`.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W2-1 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiProvidersModule {}
