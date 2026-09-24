import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AI_RUN_QUEUE } from '../ai.constants';
import { AiCoreModule } from '../core/ai-core.module';
import { RUN_EVENT_BUS } from '../core/ports/run-event-bus.port';
import { AiPromptModule } from '../prompt/ai-prompt.module';
import { AiProvidersModule } from '../providers/ai-providers.module';
import { AiSettingsModule } from '../settings/ai-settings.module';
import { AgentLoop } from './agent-loop';
import { AgentRunOrchestrator } from './agent-run.orchestrator';
import { AgentRunSweeper } from './agent-run.sweeper';
import { AgentRunWorker } from './agent-run.worker';
import { AiApprovalService } from './approval.service';
import { AiRunLimits } from './limits';
import { AiRunPrincipals } from './principal-context';
import { InProcessRunEventBus } from './run-event-bus';
import { AiRunLifecycle } from './run-lifecycle';
import { AiRunQueue } from './run-queue';
import { AiStepUpVerifier } from './step-up.verifier';

/**
 * The agent runtime (ADR-0097 decisions 4–6; provider-and-runtime.md §6–§8; synthesis §4.4, §4.6): the
 * loop, the orchestrator, the in-process `ai-run` BullMQ worker, the sweeper, the approval service with
 * the password step-up, the limits, and the in-process `RUN_EVENT_BUS`.
 *
 * Imports the tool core (`AiToolService`, the registry), the provider layer (`CHAT_MODEL_PORT`), the
 * settings reader (`AI_SETTINGS_READER`) and the prompt builder. `PrismaService`, the principal loader,
 * the permission resolver and the local credential verifier come from the global Prisma and Auth
 * modules; the BullMQ connection from the global `QueueModule`.
 *
 * Exports what the HTTP surfaces (W3-1) call — the orchestrator, the approval service — and the event
 * bus, both by its port token and as the concrete class (which adds `lastSeq` for `run.snapshot`).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: AI_RUN_QUEUE }),
    AiCoreModule,
    AiProvidersModule,
    AiSettingsModule,
    AiPromptModule,
  ],
  providers: [
    {
      provide: InProcessRunEventBus,
      useFactory: () => new InProcessRunEventBus(),
    },
    { provide: RUN_EVENT_BUS, useExisting: InProcessRunEventBus },
    AiRunQueue,
    AiRunLimits,
    AiRunPrincipals,
    AiRunLifecycle,
    AgentLoop,
    AgentRunOrchestrator,
    AiStepUpVerifier,
    AiApprovalService,
    AgentRunWorker,
    AgentRunSweeper,
  ],
  exports: [
    RUN_EVENT_BUS,
    InProcessRunEventBus,
    AgentRunOrchestrator,
    AiApprovalService,
  ],
})
export class AiRuntimeModule {}
