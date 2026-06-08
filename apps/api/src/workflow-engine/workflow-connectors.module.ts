import { Module } from '@nestjs/common';
import { ConnectorRegistry } from './connectors.registry';
import { ManualStepHandler } from './handlers/manual.handler';
import { RestStepHandler } from './handlers/rest.handler';
import { WebhookOutStepHandler } from './handlers/webhook-out.handler';
import { SecretService } from './secrets/secret.service';

/**
 * WorkflowConnectorsModule — the outbound EXECUTION PRIMITIVES of the Applications Workflow Engine
 * (Phase 1b-A, ADR-0054 / epic #248): the encrypted {@link SecretService}, the three v1 connector
 * handlers, and the {@link ConnectorRegistry} that keys them by `kind`.
 *
 * It PROVIDES + EXPORTS everything the engine CORE (Phase 1b-B) needs to import. It is deliberately
 * NOT registered in `app.module.ts` here — the CORE's `WorkflowEngineModule` imports this module and
 * is the one wired into the app (along with the AccessGrant trigger, the run orchestrator, the BullMQ
 * worker and the HTTP controllers — all 1b-B).
 *
 * `PrismaService` (needed by {@link SecretService}) comes from the global `PrismaModule`, so it does
 * not need importing here.
 */
@Module({
  providers: [
    SecretService,
    RestStepHandler,
    WebhookOutStepHandler,
    ManualStepHandler,
    ConnectorRegistry,
  ],
  exports: [
    SecretService,
    RestStepHandler,
    WebhookOutStepHandler,
    ManualStepHandler,
    ConnectorRegistry,
  ],
})
export class WorkflowConnectorsModule {}
