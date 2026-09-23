import { Module } from '@nestjs/common';

/**
 * The agent runtime: the loop, the `ai-run` BullMQ worker, the sweeper, the approval service, the limits and the in-process `RunEventBus`.
 *
 * Pre-created empty by the AI core unit (ADR-0097; docs/ai-assistant/_synthesis.md §5, §10) so the unit
 * that owns it — W2-3 — fills it without touching `ai.module.ts` or `app.module.ts`.
 */
@Module({})
export class AiRuntimeModule {}
