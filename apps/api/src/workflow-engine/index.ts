/**
 * Applications Workflow Engine — outbound EXECUTION PRIMITIVES (Phase 1b-A, ADR-0054 / epic #248).
 *
 * The self-contained "outbound half": the StepHandler contract, the three v1 connector handlers
 * (REST + WEBHOOK_OUT + MANUAL), the encrypted SecretService, the logic-less data mapper, the
 * connector registry, and the NestJS module that wires them. The engine CORE (Phase 1b-B — run
 * orchestrator, BullMQ worker, AccessGrant trigger, HTTP controllers) IMPORTS from here.
 *
 * This barrel is the single import surface 1b-B consumes.
 */

// The NestJS module (provides + exports SecretService, the handlers and the registry).
export { WorkflowConnectorsModule } from './workflow-connectors.module';

// The registry (kind → handler).
export { ConnectorRegistry } from './connectors.registry';

// The StepHandler contract + its input/output types (what 1b-B builds against).
export {
  freezeMappingContext,
  isTransientStatus,
  RETRYABLE_HTTP_STATUSES,
  type ManualTaskSpec,
  type RedactedStepMetadata,
  type RevealSecret,
  type StepContext,
  type StepHandler,
  type StepOutcomeStatus,
  type StepRequestMeta,
  type StepResult,
  type TestConnectionContext,
  type TestConnectionResult,
  type WorkflowMappingContext,
} from './handlers/step-handler';

// The concrete handlers (also injectable directly).
export { ManualStepHandler } from './handlers/manual.handler';
export { RestStepHandler } from './handlers/rest.handler';
export { WebhookOutStepHandler } from './handlers/webhook-out.handler';

// The encrypted secret store.
export {
  CURRENT_KEY_VERSION,
  resolveWorkflowSecretKey,
  SecretService,
  WORKFLOW_SECRET_KEY_ENV,
  type SecretEnvelope,
  type SecretEnvelopeInput,
  type WorkflowSecretDescriptor,
} from './secrets/secret.service';

// The logic-less data mapper.
export {
  ALLOWED_ROOTS,
  mapData,
  renderTemplate,
  type EncodingMode,
  type MapResult,
} from './mapping/data-mapper';
