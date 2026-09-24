import { Module } from '@nestjs/common';
import { AiCoreModule } from '../core/ai-core.module';
import { AiRuntimeModule } from '../runtime/ai-runtime.module';
import { AiRunsController } from './ai-runs.controller';
import { AiRunsService } from './ai-runs.service';
import { AiRunEventStream } from './run-event-stream';

/**
 * `/ai/runs` — run creation (chat and headless), the run read, cancel, the approval decision endpoint with
 * the password step-up, and the SSE event stream (ADR-0097 decisions 4–6; synthesis §4.7; W3-1).
 *
 * Imports the runtime for the orchestrator, the approval service and the concrete in-process event bus
 * (`lastSeq` for `run.snapshot`), and the tool core for the registry (the class of a call). PrismaService
 * and the auth guards are global.
 */
@Module({
  imports: [AiRuntimeModule, AiCoreModule],
  controllers: [AiRunsController],
  providers: [AiRunsService, AiRunEventStream],
})
export class AiRunsModule {}
