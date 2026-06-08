import { Injectable } from '@nestjs/common';
import type { WorkflowConnectionKind } from '@lazyit/shared';
import { ManualStepHandler } from './handlers/manual.handler';
import { RestStepHandler } from './handlers/rest.handler';
import { WebhookOutStepHandler } from './handlers/webhook-out.handler';
import type { StepHandler } from './handlers/step-handler';

/**
 * ConnectorRegistry — the `kind` → {@link StepHandler} lookup the engine CORE (Phase 1b-B) uses to
 * select the executor for a step (capability-by-key, mirroring the in-tree `IdentityProvider` factory;
 * never `instanceof`).
 *
 * v1 registers the three declarative handlers: REST + WEBHOOK_OUT + MANUAL. The RESERVED kinds
 * (`SDK` / `MCP` / `PREBUILT` / `CUSTOM`) are intentionally absent — {@link get} returns `undefined`
 * and {@link require} throws a clear "not implemented in v1" error, so the CORE fails the run loudly
 * rather than silently no-op'ing a reserved connector.
 */
@Injectable()
export class ConnectorRegistry {
  private readonly handlers: ReadonlyMap<WorkflowConnectionKind, StepHandler>;

  constructor(
    rest: RestStepHandler,
    webhookOut: WebhookOutStepHandler,
    manual: ManualStepHandler,
  ) {
    this.handlers = new Map<WorkflowConnectionKind, StepHandler>([
      [rest.kind, rest],
      [webhookOut.kind, webhookOut],
      [manual.kind, manual],
    ]);
  }

  /** The handler for a kind, or `undefined` for a RESERVED/unimplemented kind. */
  get(kind: WorkflowConnectionKind): StepHandler | undefined {
    return this.handlers.get(kind);
  }

  /** Whether a kind has a v1 handler. */
  has(kind: WorkflowConnectionKind): boolean {
    return this.handlers.has(kind);
  }

  /** The handler for a kind, or throw if RESERVED/unimplemented (the CORE then fails the run). */
  require(kind: WorkflowConnectionKind): StepHandler {
    const handler = this.handlers.get(kind);
    if (!handler) {
      throw new Error(
        `No workflow connector handler for kind "${kind}" — it is a reserved slot not implemented in v1 ` +
          `(v1 = REST, WEBHOOK_OUT, MANUAL).`,
      );
    }
    return handler;
  }

  /** The kinds that have a v1 handler (for diagnostics / introspection). */
  get kinds(): WorkflowConnectionKind[] {
    return [...this.handlers.keys()];
  }
}
