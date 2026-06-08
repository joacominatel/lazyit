import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DEFAULT_RETRY_POLICY,
  isHttpStatusSuccess,
  resolveStepTransitions,
  WORKFLOW_COMPENSATE,
  WORKFLOW_END_SUCCESS,
  WORKFLOW_ESCALATE_TO_MANUAL,
  WORKFLOW_STOP_FAIL,
  WorkflowConnectionConfigSchema,
  WorkflowStepsSchema,
  type RetryPolicy,
  type WorkflowStep,
} from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectorRegistry } from '../connectors.registry';
import { SecretService } from '../secrets/secret.service';
import type {
  ManualTaskSpec,
  RevealSecret,
  StepResult,
  WorkflowMappingContext,
} from '../handlers/step-handler';
import { RunContextBuilder } from './run-context';
import {
  classifyFailureEdge,
  classifySuccessEdge,
  isTerminalTarget,
} from './transitions';
import { MAX_WALK_STEPS } from './workflow-run.constants';
import type { ManualTaskOrigin, TransitionTaken } from './workflow-run.types';

/** A clock/sleep seam so the per-step retry backoff is a no-op in unit tests (no real timers). */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
export const WORKFLOW_SLEEPER = 'WORKFLOW_SLEEPER';
export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The outcome of executing one step across its retry attempts (the FINAL attempt's data). */
interface StepExecution {
  status: 'SUCCEEDED' | 'FAILED' | 'AWAITING_INPUT';
  attempt: number;
  metadata: Record<string, unknown>;
  externalCorrelationId?: string | null;
  manualTaskSpec?: ManualTaskSpec;
}

/**
 * The run orchestrator — the normative DAG walk of ADR-0054 §8 over a pinned `WorkflowVersion.steps`.
 * Entry node `steps[0]`; PENDING→RUNNING (guarded, idempotent); execute each step via the
 * `ConnectorRegistry`; ONE append-only `WorkflowStepRun` per attempt; retry per `step.retry`
 * (absent ⇒ a single attempt; retried only when the handler signals `retryable`); classify
 * SUCCEEDED / FAILED / AWAITING_INPUT and follow the edge via the shared `resolveStepTransitions`
 * (NEVER re-deriving precedence). The walk terminates because the graph is acyclic (author-time).
 *
 * The grant is NEVER touched here (the decoupling invariant §1): compensation is best-effort and only
 * appends COMPENSATED ledger rows.
 */
@Injectable()
export class WorkflowRunOrchestrator {
  private readonly logger = new Logger(WorkflowRunOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly secrets: SecretService,
    private readonly contextBuilder: RunContextBuilder,
    @Inject(WORKFLOW_SLEEPER) private readonly sleeper: Sleeper,
  ) {}

  // ── public entrypoints ────────────────────────────────────────────────────

  /**
   * Start a freshly-created run. Atomically flips PENDING→RUNNING (the run is the idempotency unit, so
   * a duplicate start/sweeper job that loses the race is a no-op), then walks from the entry node.
   */
  async start(runId: string): Promise<void> {
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'PENDING' },
      data: { status: 'RUNNING', startedAt: new Date() },
    });
    if (claimed.count === 0) {
      // Another worker already started it, or it is paused/terminal — idempotent skip.
      return;
    }
    await this.walk(runId, undefined);
  }

  /**
   * Resume a paused run after a manual task resolved. Atomically flips AWAITING_INPUT→RUNNING (guarded,
   * so exactly one resume job proceeds — a duplicate is a no-op), then walks from the resume cursor (the
   * resolved next target: a step key, or a terminal token the walk finalizes directly).
   */
  async resume(runId: string, resumeCursor: string): Promise<void> {
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'AWAITING_INPUT' },
      data: { status: 'RUNNING' },
    });
    if (claimed.count === 0) {
      // Not paused (double-resume / already advanced / terminal) — idempotent skip.
      return;
    }
    await this.walk(runId, resumeCursor);
  }

  // ── the walk ──────────────────────────────────────────────────────────────

  private async walk(
    runId: string,
    startCursor: string | undefined,
  ): Promise<void> {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId },
      include: { workflowVersion: true },
    });
    if (!run) {
      throw new Error(`WorkflowRun ${runId} not found`);
    }
    const steps = WorkflowStepsSchema.parse(run.workflowVersion.steps);
    const ctx = await this.contextBuilder.build(runId);

    let cursor: string = startCursor ?? steps[0].key;

    for (let guard = 0; guard < MAX_WALK_STEPS; guard++) {
      if (isTerminalTarget(cursor)) {
        await this.finalizeTerminal(runId, cursor);
        return;
      }
      const index = steps.findIndex((s) => s.key === cursor);
      if (index < 0) {
        await this.finalizeFailed(runId, cursor, 'cursor-not-found');
        return;
      }
      const step = steps[index];
      const exec = await this.executeWithRetries(run.id, step, index, ctx);
      const { onSuccess, onFailure } = resolveStepTransitions(steps, index);

      // A MANUAL step's own pause (handler returned AWAITING_INPUT): create the task, pause the run.
      if (exec.status === 'AWAITING_INPUT') {
        const task = await this.createManualTask(
          runId,
          step,
          'MANUAL_STEP',
          exec.manualTaskSpec,
        );
        await this.appendStepRun(
          runId,
          step,
          index,
          exec.attempt,
          'AWAITING_INPUT',
          {
            ...exec.metadata,
            transitionTaken: {
              outcome: 'PAUSE',
              edge: 'PAUSE',
            } satisfies TransitionTaken,
            manualTaskId: task.id,
          },
        );
        await this.setStatus(runId, 'AWAITING_INPUT');
        return;
      }

      if (exec.status === 'SUCCEEDED') {
        const transitionTaken = classifySuccessEdge(steps, index, onSuccess);
        await this.appendStepRun(
          runId,
          step,
          index,
          exec.attempt,
          'SUCCEEDED',
          { ...exec.metadata, transitionTaken },
          exec.externalCorrelationId ?? null,
        );
        if (onSuccess === WORKFLOW_END_SUCCESS) {
          await this.setStatus(runId, 'SUCCEEDED');
          return;
        }
        cursor = onSuccess;
        continue;
      }

      // FAILED (after retries, handler stopped marking it retryable) — follow `onFailure`.
      if (onFailure === WORKFLOW_ESCALATE_TO_MANUAL) {
        const task = await this.createManualTask(
          runId,
          step,
          'ESCALATED_FAILURE',
        );
        await this.appendStepRun(runId, step, index, exec.attempt, 'FAILED', {
          ...exec.metadata,
          transitionTaken: {
            outcome: 'FAILURE',
            edge: 'ESCALATE',
          } satisfies TransitionTaken,
          manualTaskId: task.id,
        });
        await this.setStatus(runId, 'AWAITING_INPUT');
        return;
      }
      if (onFailure === WORKFLOW_COMPENSATE) {
        await this.appendStepRun(runId, step, index, exec.attempt, 'FAILED', {
          ...exec.metadata,
          transitionTaken: {
            outcome: 'FAILURE',
            edge: 'COMPENSATE',
          } satisfies TransitionTaken,
        });
        await this.runCompensation(runId);
        await this.setStatus(runId, 'COMPENSATED');
        return;
      }
      if (onFailure === WORKFLOW_STOP_FAIL) {
        await this.appendStepRun(runId, step, index, exec.attempt, 'FAILED', {
          ...exec.metadata,
          transitionTaken: {
            outcome: 'FAILURE',
            edge: 'STOP',
          } satisfies TransitionTaken,
        });
        await this.finalizeFailed(
          runId,
          step.key,
          (exec.metadata.errorClass as string | undefined) ?? 'step-failed',
        );
        return;
      }

      // onFailure is a step key — a CONTINUE (fall-through) or a GOTO to an error-handler step.
      const transitionTaken = classifyFailureEdge(onFailure, onSuccess);
      await this.appendStepRun(runId, step, index, exec.attempt, 'FAILED', {
        ...exec.metadata,
        transitionTaken,
      });
      cursor = onFailure;
    }

    // Defensive: an acyclic graph can never reach this, but never loop forever.
    await this.finalizeFailed(runId, cursor, 'walk-exceeded-max-steps');
  }

  // ── step execution + retries ────────────────────────────────────────────────

  /**
   * Execute one step, honouring its retry policy. Writes an append-only `WorkflowStepRun` for each
   * RETRIED (transient-failed) attempt and returns the FINAL attempt's classified outcome (the walk
   * writes the final row, stamped with the transition it then takes). Absent `retry` ⇒ a single
   * attempt; a retry fires only when the handler marked the failure `retryable`.
   */
  private async executeWithRetries(
    runId: string,
    step: WorkflowStep,
    index: number,
    ctx: Readonly<WorkflowMappingContext>,
  ): Promise<StepExecution> {
    const handler = this.registry.get(step.kind);
    if (!handler) {
      return {
        status: 'FAILED',
        attempt: 1,
        metadata: {
          errorClass: 'connector-unavailable',
          reason: `no handler for kind ${step.kind}`,
        },
      };
    }

    // Resolve the connector config + credential accessor for this step.
    const resolved = await this.resolveConnection(step);
    if ('error' in resolved) {
      return { status: 'FAILED', attempt: 1, metadata: resolved.error };
    }

    const policy: RetryPolicy =
      'retry' in step && step.retry ? step.retry : DEFAULT_RETRY_POLICY;
    const maxAttempts = policy.maxAttempts;

    let attempt = 0;
    for (;;) {
      attempt += 1;
      let raw: StepResult;
      try {
        raw = await handler.execute({
          connection: resolved.config as never,
          step: step,
          revealSecret: resolved.revealSecret,
          data: ctx,
          meta: { runId, stepKey: step.key, stepIndex: index, attempt },
        });
      } catch (err) {
        // A handler should never throw for an EXPECTED failure, but be defensive.
        raw = {
          status: 'FAILED',
          retryable: false,
          metadata: { errorClass: 'handler-threw', reason: messageOf(err) },
        };
      }

      const classified = this.classify(raw, step);
      if (
        classified.status === 'AWAITING_INPUT' ||
        classified.status === 'SUCCEEDED'
      ) {
        return {
          status: classified.status,
          attempt,
          metadata: classified.metadata,
          externalCorrelationId: classified.externalCorrelationId,
          manualTaskSpec: raw.manualTask,
        };
      }

      // FAILED — retry only if the handler signalled retryable and attempts remain.
      if (classified.retryable && attempt < maxAttempts) {
        await this.appendStepRun(runId, step, index, attempt, 'FAILED', {
          ...classified.metadata,
          retriedAfterMs: backoffMs(policy, attempt),
        });
        await this.sleeper.sleep(backoffMs(policy, attempt));
        continue;
      }
      return { status: 'FAILED', attempt, metadata: classified.metadata };
    }
  }

  /**
   * Re-classify a handler result against the step's `successCriteria` (the orchestrator owns the
   * success window, ADR-0054 §8 — the HTTP handler only reports raw 2xx/non-2xx + the status code). A
   * declared `successCriteria` can make a non-2xx (e.g. 404 "already gone" on revoke) a SUCCESS, or a
   * 2xx outside the window a FAILURE.
   */
  private classify(
    raw: StepResult,
    step: WorkflowStep,
  ): {
    status: 'SUCCEEDED' | 'FAILED' | 'AWAITING_INPUT';
    retryable: boolean;
    metadata: Record<string, unknown>;
    externalCorrelationId?: string | null;
  } {
    const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
    if (raw.status === 'AWAITING_INPUT') {
      return { status: 'AWAITING_INPUT', retryable: false, metadata };
    }
    const statusCode = metadata.statusCode;
    const isHttp = step.kind === 'REST' || step.kind === 'WEBHOOK_OUT';
    if (isHttp && typeof statusCode === 'number') {
      const ok = isHttpStatusSuccess(
        statusCode,
        'successCriteria' in step ? step.successCriteria : undefined,
      );
      return {
        status: ok ? 'SUCCEEDED' : 'FAILED',
        retryable: ok ? false : (raw.retryable ?? false),
        metadata,
        externalCorrelationId: ok ? raw.externalCorrelationId : null,
      };
    }
    // No status code (network/config error, or a non-HTTP result) — trust the handler's verdict.
    return {
      status: raw.status,
      retryable: raw.retryable ?? false,
      metadata,
      externalCorrelationId: raw.externalCorrelationId,
    };
  }

  /** Load + validate the connection config and build the in-memory credential accessor for a step. */
  private async resolveConnection(
    step: WorkflowStep,
  ): Promise<
    | { config: unknown; revealSecret: RevealSecret }
    | { error: Record<string, unknown> }
  > {
    if (step.kind === 'MANUAL') {
      // A MANUAL step references no connection; the handler needs only the `{ kind: 'MANUAL' }` config.
      return {
        config: { kind: 'MANUAL' },
        revealSecret: () => Promise.resolve(null),
      };
    }
    const connection = await this.prisma.workflowConnection.findFirst({
      where: { id: step.connectionId, deletedAt: null },
    });
    if (!connection) {
      return {
        error: {
          errorClass: 'config',
          reason: `connection ${step.connectionId} not found or deleted`,
        },
      };
    }
    const parsed = WorkflowConnectionConfigSchema.safeParse(connection.config);
    if (!parsed.success) {
      return {
        error: { errorClass: 'config', reason: 'invalid connection config' },
      };
    }
    const secretId = connection.secretId;
    const revealSecret: RevealSecret = secretId
      ? () => this.secrets.revealById(secretId)
      : () => Promise.resolve(null);
    return { config: parsed.data, revealSecret };
  }

  // ── compensation (saga) ──────────────────────────────────────────────────

  /**
   * Best-effort saga compensation (ADR-0054 §8.6): for every already-SUCCEEDED step in this run, append
   * a COMPENSATED ledger row in REVERSE completion order. v1 has no per-step compensation ACTION in the
   * step contract, so this records the rollback intent (the audit trail) and NEVER touches the grant; a
   * concrete compensating call per step is a future additive contract field.
   */
  private async runCompensation(runId: string): Promise<void> {
    const succeeded = await this.prisma.workflowStepRun.findMany({
      where: { runId, status: 'SUCCEEDED' },
      orderBy: { id: 'desc' },
    });
    let order = 0;
    for (const sr of succeeded) {
      order += 1;
      await this.prisma.workflowStepRun.create({
        data: {
          runId,
          stepIndex: sr.stepIndex,
          stepKey: sr.stepKey,
          attempt: 1,
          status: 'COMPENSATED',
          metadata: {
            reason: 'saga compensation (reverse order)',
            compensationStepKey: sr.stepKey,
            compensationOrder: order,
          },
        },
      });
    }
  }

  // ── manual tasks ───────────────────────────────────────────────────────────

  /** Create a PENDING ManualTask for a paused (MANUAL) or escalated (failed) step. */
  private async createManualTask(
    runId: string,
    step: WorkflowStep,
    origin: ManualTaskOrigin,
    spec?: ManualTaskSpec,
  ) {
    const prompt =
      spec?.prompt ??
      `Step "${step.name ?? step.key}" failed and was escalated for manual handling.`;
    const cohort = spec?.cohort ?? null;
    return this.prisma.manualTask.create({
      data: {
        runId,
        stepKey: step.key,
        prompt,
        cohort,
        status: 'PENDING',
      },
    });
  }

  // ── ledger + status writes ──────────────────────────────────────────────────

  /** Append one immutable WorkflowStepRun attempt row (never updated; ADR-0006). Metadata is redacted. */
  private appendStepRun(
    runId: string,
    step: WorkflowStep,
    stepIndex: number,
    attempt: number,
    status:
      | 'SUCCEEDED'
      | 'FAILED'
      | 'AWAITING_INPUT'
      | 'COMPENSATED'
      | 'SKIPPED',
    metadata: Record<string, unknown>,
    externalCorrelationId: string | null = null,
  ) {
    return this.prisma.workflowStepRun.create({
      data: {
        runId,
        stepIndex,
        stepKey: step.key,
        attempt,
        status,
        externalCorrelationId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  private async setStatus(
    runId: string,
    status:
      | 'RUNNING'
      | 'AWAITING_INPUT'
      | 'SUCCEEDED'
      | 'FAILED'
      | 'COMPENSATED',
  ): Promise<void> {
    const terminal =
      status === 'SUCCEEDED' || status === 'FAILED' || status === 'COMPENSATED';
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: { status, ...(terminal ? { finishedAt: new Date() } : {}) },
    });
  }

  /** Terminal failure: set FAILED + a REDACTED error summary (step key + class — never bodies/PII). */
  private async finalizeFailed(
    runId: string,
    stepKey: string,
    errorClass: string,
  ): Promise<void> {
    await this.prisma.workflowRun.update({
      where: { id: runId },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        error: { stepKey, errorClass },
      },
    });
    this.logger.warn(
      `workflow.run_failed run=${runId} step=${stepKey} class=${errorClass}`,
    );
  }

  private async finalizeTerminal(
    runId: string,
    terminal: string,
  ): Promise<void> {
    if (terminal === WORKFLOW_END_SUCCESS) {
      await this.setStatus(runId, 'SUCCEEDED');
      return;
    }
    if (terminal === WORKFLOW_COMPENSATE) {
      await this.runCompensation(runId);
      await this.setStatus(runId, 'COMPENSATED');
      return;
    }
    // STOP_FAIL / ESCALATE reached directly as a resume cursor — finalize as a redacted failure.
    await this.finalizeFailed(runId, terminal, 'terminal');
  }
}

/** Exponential/fixed backoff between attempts, derived from the step's retry policy. */
export function backoffMs(policy: RetryPolicy, attempt: number): number {
  if (policy.backoff === 'fixed') {
    return policy.delayMs;
  }
  // exponential: delayMs * 2^(attempt-1), capped at 1h (the schema's own delayMs ceiling).
  return Math.min(policy.delayMs * 2 ** (attempt - 1), 3_600_000);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
