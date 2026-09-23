import { Module } from '@nestjs/common';

/**
 * The domain primer (`LAZYIT_DOMAIN_PRIMER`) and the system-prompt builder, shared by the runtime, the MCP `instructions` and the skill.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W2-11 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiPromptModule {}
