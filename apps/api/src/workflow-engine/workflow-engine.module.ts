import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WorkflowConnectorsModule } from './workflow-connectors.module';
import { WORKFLOW_RUN_QUEUE } from './run/workflow-run.constants';
import { WorkflowTriggerService } from './run/workflow-trigger.service';
import { RunContextBuilder } from './run/run-context';
import {
  realSleeper,
  WORKFLOW_SLEEPER,
  WorkflowRunOrchestrator,
} from './run/workflow-run.orchestrator';
import { WorkflowRunWorker } from './run/workflow-run.worker';
import { WorkflowRunSweeper } from './run/workflow-run.sweeper';
import { EngineServiceAccountService } from './engine-service-account.service';
import { WorkflowRunsController } from './runs/workflow-runs.controller';
import { WorkflowRunsService } from './runs/workflow-runs.service';
import { ManualTasksController } from './tasks/manual-tasks.controller';
import { ManualTasksService } from './tasks/manual-tasks.service';
import { WorkflowsController } from './definitions/workflows.controller';
import { WorkflowsService } from './definitions/workflows.service';
import { WorkflowConnectionsController } from './definitions/workflow-connections.controller';
import { WorkflowConnectionsService } from './definitions/workflow-connections.service';
import { WorkflowSecretsController } from './definitions/workflow-secrets.controller';
import { WorkflowSecretsService } from './definitions/workflow-secrets.service';

/**
 * WorkflowEngineModule — the engine CORE (Phase 1b-B, ADR-0054 / epic #248). It imports the outbound
 * EXECUTION PRIMITIVES ({@link WorkflowConnectorsModule}: SecretService + the v1 handlers + the
 * ConnectorRegistry) and registers its own `workflow-run` BullMQ queue, which INHERITS the shared,
 * robust Valkey connection the global `QueueModule` provides (issue #257 — never a hand-rolled ioredis).
 *
 * It wires:
 *  - the AccessGrant → workflow TRANSACTIONAL OUTBOX ({@link WorkflowTriggerService}, exported so
 *    `AccessGrantsModule` fires it inside the grant tx — the INV-5 inverse decoupling);
 *  - the run ORCHESTRATOR (the ADR-0054 §8 DAG walk) + the in-process BullMQ WORKER + the PENDING-run
 *    SWEEPER ("Postgres remembers");
 *  - the run-status (C2), manual-task (C5) and definition/connection/secret (C1) HTTP controllers.
 *
 * Importing this module activates SecretService's fail-loud `onModuleInit` — the app requires a valid
 * `WORKFLOW_SECRET_KEY` at boot (a half-configured secret store is worse than an absent one).
 */
@Module({
  imports: [
    WorkflowConnectorsModule,
    // Registers the `workflow-run` queue (and its @Processor worker) on the GLOBAL shared connection.
    BullModule.registerQueue({ name: WORKFLOW_RUN_QUEUE }),
  ],
  controllers: [
    WorkflowRunsController,
    ManualTasksController,
    WorkflowsController,
    WorkflowConnectionsController,
    WorkflowSecretsController,
  ],
  providers: [
    // run substrate
    WorkflowTriggerService,
    RunContextBuilder,
    WorkflowRunOrchestrator,
    WorkflowRunWorker,
    WorkflowRunSweeper,
    EngineServiceAccountService,
    { provide: WORKFLOW_SLEEPER, useValue: realSleeper },
    // read + CRUD services
    WorkflowRunsService,
    ManualTasksService,
    WorkflowsService,
    WorkflowConnectionsService,
    WorkflowSecretsService,
  ],
  // The trigger/outbox is consumed by AccessGrantsModule (the grant tx writes the PENDING run row).
  exports: [WorkflowTriggerService, EngineServiceAccountService],
})
export class WorkflowEngineModule {}
