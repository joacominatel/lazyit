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
import { Prisma } from '../../../generated/prisma/client';
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
import { NotificationsService } from '../../notifications/notifications.service';
import {
  classifyFailureEdge,
  classifySuccessEdge,
  isTerminalTarget,
} from './transitions';
import {
  MAX_INPROCESS_BACKOFF_MS,
  MAX_WALK_STEPS,
} from './workflow-run.constants';
import type { TransitionTaken } from './workflow-run.types';
import { WorkflowTriggerService } from './workflow-trigger.service';

/** A clock/sleep seam so the per-step retry backoff is a no-op in unit tests (no real timers). */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}
export const WORKFLOW_SLEEPER = 'WORKFLOW_SLEEPER';
export const realSleeper: Sleeper = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * The classified outcome of executing ONE attempt of a step (CCOR-3 — the per-attempt unit; the retry
 * backoff is no longer an in-process loop). `RETRY` means "transient failure, attempts remain" — the
 * walk schedules the next attempt OFF the worker (a delayed re-enqueue) instead of sleeping in-slot.
 */
type StepOutcome =
  | {
      status: 'AWAITING_INPUT';
      attempt: number;
      metadata: Record<string, unknown>;
      manualTaskSpec?: ManualTaskSpec;
    }
  | {
      status: 'SUCCEEDED';
      attempt: number;
      metadata: Record<string, unknown>;
      externalCorrelationId?: string | null;
    }
  | { status: 'FAILED'; attempt: number; metadata: Record<string, unknown> }
  | {
      status: 'RETRY';
      attempt: number;
      metadata: Record<string, unknown>;
      retryDelayMs: number;
    };

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

  /**
   * OPTION 2 (ADR-0057) — the TRANSIENT, single-use manual-retry payload override, held IN MEMORY ONLY,
   * keyed by runId. Set EXCLUSIVELY by {@link retryRun} (the manual operator path) and consumed exactly
   * ONCE by the next {@link walk} for that run when it re-enters the failed step; then DELETED.
   *
   * INV-6 (hard boundary): the operator-typed override NEVER touches Valkey (it does NOT ride the BullMQ
   * job — the job payload stays `{ runId, retryStepKey, retryAttempt }`, Postgres-is-truth) and NEVER
   * touches Postgres / the ledger / a log. The in-process BullMQ worker shares this singleton orchestrator
   * instance, so the delayed-0 retry job re-enters the SAME instance and finds the override. A broker-down
   * retry (no job scheduled) simply re-renders WITHOUT the override and fails again deterministically — the
   * operator retries once the broker is back; nothing is persisted to recover, by design. The AUTOMATIC
   * per-attempt retry ({@link retryStep}) never reads this map — it stays deterministic + pinned.
   */
  private readonly pendingOverrides = new Map<
    string,
    { stepKey: string; fields: Record<string, string> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistry,
    private readonly secrets: SecretService,
    private readonly contextBuilder: RunContextBuilder,
    @Inject(WORKFLOW_SLEEPER) private readonly sleeper: Sleeper,
    private readonly trigger: WorkflowTriggerService,
    private readonly notifications: NotificationsService,
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

  /**
   * Re-enter a RUNNING run at `stepKey` to execute its NEXT retry `attempt` after the per-step backoff
   * elapsed OFF the worker (CCOR-3 — a delayed job, not an in-process sleep). Idempotent against a stalled
   * re-delivery: if this attempt already produced an append-only row it is a no-op; and only a run still
   * RUNNING proceeds (a run finalized meanwhile — e.g. by the RUNNING-staleness reconciler — is skipped).
   */
  async retryStep(
    runId: string,
    stepKey: string,
    attempt: number,
  ): Promise<void> {
    const already = await this.prisma.workflowStepRun.findFirst({
      where: { runId, stepKey, attempt },
      select: { id: true },
    });
    if (already) {
      // This attempt was already executed (the delayed job was re-delivered) — idempotent skip.
      return;
    }
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId },
      select: { status: true },
    });
    if (!run || run.status !== 'RUNNING') {
      // The run advanced/terminated while the retry sat delayed — a stale retry is a no-op.
      return;
    }
    await this.walk(runId, stepKey, attempt);
  }

  /**
   * Manually retry a TERMINAL `FAILED` run from the step that failed onward (issue #308 — the operator
   * re-drives a run after, e.g., a transient external outage; NOT the engine's own per-attempt transient
   * retry, which is {@link retryStep}). RESUME-FROM-FAILED-STEP, never a full re-run: the walk re-enters
   * at the FAILED step's key, so every already-`SUCCEEDED` step BEFORE it is skipped (a non-idempotent
   * create cannot double-provision). Steps are append-only — the failed step re-executes as a NEW attempt
   * (max prior attempt + 1) and downstream steps run their own fresh attempts.
   *
   * The transition is a GUARDED compare-and-set: only a run still `FAILED` flips `FAILED`→`RUNNING`
   * (`updateMany`'s `count` is the gate), so a double-retry — or a retry racing the sweeper — is
   * idempotent: exactly one proceeds. Default policy: ONLY `FAILED` is retryable. A `COMPENSATED` run
   * already rolled its external effects back, so re-driving it would re-provision what compensation just
   * undid — resolve it by re-granting, not retrying (the caller rejects non-`FAILED` runs with a 409).
   *
   * The walk runs OFF the request via a delayed-0 retry job (the decoupled posture, §1); the worker's
   * {@link retryStep} re-enters at this exact step+attempt. A broker-down enqueue leaves the run `RUNNING`
   * for the RUNNING-staleness reconciler to finalize (the operator simply retries again once Valkey is
   * back) — never a synchronous external call on the request thread.
   *
   * OPTION 2 (ADR-0057) — an OPTIONAL `overrides` map (field name → template-or-literal) patches the
   * FAILED step's data mapping for the NEXT attempt ONLY. It is stored TRANSIENTLY in {@link
   * pendingOverrides} (in memory, never Valkey/Postgres/logs) and consumed by the next walk's render of
   * that step; only the field NAMES are ever recorded (INV-6). A no-override retry is unchanged.
   *
   * @returns `{ retried: true, resumeStepKey, attempt }` on a successful CAS, or `{ retried: false }`
   *   when the run was not `FAILED` at claim time (the caller maps that to a 409 conflict).
   */
  async retryRun(
    runId: string,
    overrides?: Record<string, string>,
  ): Promise<
    | { retried: true; resumeStepKey: string; attempt: number }
    | { retried: false }
  > {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id: runId },
      include: { workflowVersion: true },
    });
    if (!run) {
      throw new Error(`WorkflowRun ${runId} not found`);
    }
    // Resolve the failed step BEFORE the CAS so a missing/unknown failed-step record is a clean
    // precondition failure (caller → 422), never a half-flipped run left RUNNING with nowhere to go.
    const steps = WorkflowStepsSchema.parse(run.workflowVersion.steps);
    const failedStepKey = resolveFailedStepKey(run.error, steps);
    if (!failedStepKey) {
      throw new RetryNotResolvableError(
        `WorkflowRun ${runId} has no resolvable failed step to retry from`,
      );
    }
    const nextAttempt = await this.nextAttemptFor(runId, failedStepKey);

    // Guarded CAS: ONLY a run still FAILED flips to RUNNING. A lost race (already RUNNING / re-retried /
    // swept) yields count 0 — the caller surfaces a clean conflict and we enqueue nothing.
    const claimed = await this.prisma.workflowRun.updateMany({
      where: { id: runId, status: 'FAILED' },
      data: { status: 'RUNNING', finishedAt: null, error: Prisma.DbNull },
    });
    if (claimed.count === 0) {
      return { retried: false };
    }

    // Stash the transient override (Option 2) ONLY after winning the CAS, so a lost race leaves no stale
    // override behind. Scoped to the failed step; consumed once by the next walk's render of that step.
    if (overrides && Object.keys(overrides).length > 0) {
      this.pendingOverrides.set(runId, {
        stepKey: failedStepKey,
        fields: { ...overrides },
      });
    }

    // Advance OFF the request via a delayed-0 retry job (decoupled, §1). A broker-down enqueue is
    // swallowed by enqueueRetry; the run is RUNNING and the RUNNING-staleness reconciler finalizes it.
    await this.trigger.enqueueRetry(runId, failedStepKey, nextAttempt, 0);
    return {
      retried: true,
      resumeStepKey: failedStepKey,
      attempt: nextAttempt,
    };
  }

  /**
   * OPTION 2 (ADR-0057): if a one-shot manual-retry override is pending for `runId` AND targets this
   * step, return a step CLONE whose `dataMapping` is merged with the override (the override wins per
   * field), and DELETE the pending override (single use). Otherwise return the step unchanged. The
   * override never escapes this in-memory merge — it patches the mapping the handler renders for ONE
   * attempt, and only the merged field NAMES are recorded downstream (INV-6: no value is persisted).
   */
  private applyPendingOverride(
    runId: string,
    step: WorkflowStep,
  ): WorkflowStep {
    const pending = this.pendingOverrides.get(runId);
    if (!pending || pending.stepKey !== step.key) {
      return step;
    }
    // Single use: consume it now so a later step / a re-delivery never re-applies it.
    this.pendingOverrides.delete(runId);
    // Only REST / WEBHOOK_OUT steps carry a data mapping the override can patch. A MANUAL step has none —
    // the override is a no-op there (defensive; the schema-level scope is enforced at the controller).
    if (step.kind !== 'REST' && step.kind !== 'WEBHOOK_OUT') {
      return step;
    }
    return {
      ...step,
      dataMapping: { ...(step.dataMapping ?? {}), ...pending.fields },
    };
  }

  /** The next append-only attempt number for (runId, stepKey): max recorded attempt + 1 (1 if none). */
  private async nextAttemptFor(
    runId: string,
    stepKey: string,
  ): Promise<number> {
    const latest = await this.prisma.workflowStepRun.findFirst({
      where: { runId, stepKey },
      orderBy: { attempt: 'desc' },
      select: { attempt: true },
    });
    return (latest?.attempt ?? 0) + 1;
  }

  // ── the walk ──────────────────────────────────────────────────────────────

  private async walk(
    runId: string,
    startCursor: string | undefined,
    startAttempt = 1,
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
    // The attempt number for the step at `cursor`. Carried (incremented) across a degraded in-process
    // retry of the SAME step; reset to 1 whenever the cursor advances to a different step.
    let attempt = startAttempt;

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
      const baseStep = steps[index];
      const { onSuccess, onFailure } = resolveStepTransitions(steps, index);
      // OPTION 2 (ADR-0057): consume a one-shot manual-retry override for THIS step (if any). It patches
      // the step's data mapping for this single render, then is DELETED — never persisted (INV-6). Only a
      // REST/WEBHOOK_OUT step carries a `dataMapping`; the override is inert on any other kind.
      const step = this.applyPendingOverride(runId, baseStep);
      const exec = await this.executeStep(run.id, step, index, ctx, attempt);

      // A MANUAL step's own pause (handler returned AWAITING_INPUT): create the task + pause the run
      // ATOMICALLY (CCOR-2 — the task becomes resolvable only once the run is already AWAITING_INPUT, so
      // a completion can never race in while the run is still RUNNING and no-op its own resume).
      if (exec.status === 'AWAITING_INPUT') {
        await this.pauseForManual(
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
          },
          exec.manualTaskSpec,
        );
        return;
      }

      // Transient failure with attempts remaining (CCOR-3): record the attempt, then run the backoff OFF
      // the worker — a delayed re-enqueue re-enters at this same step, freeing the slot. Only when the
      // broker can't take the delayed job do we fall back to a SHORT, lock-bounded in-process backoff.
      if (exec.status === 'RETRY') {
        await this.appendStepRun(runId, step, index, exec.attempt, 'FAILED', {
          ...exec.metadata,
          retriedAfterMs: exec.retryDelayMs,
        });
        const scheduled = await this.trigger.enqueueRetry(
          runId,
          step.key,
          exec.attempt + 1,
          exec.retryDelayMs,
        );
        if (scheduled) {
          return;
        }
        await this.sleeper.sleep(
          Math.min(exec.retryDelayMs, MAX_INPROCESS_BACKOFF_MS),
        );
        attempt = exec.attempt + 1;
        continue;
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
        attempt = 1;
        continue;
      }

      // FAILED (permanent, or retries exhausted) — follow `onFailure`.
      if (onFailure === WORKFLOW_ESCALATE_TO_MANUAL) {
        await this.pauseForManual(runId, step, index, exec.attempt, 'FAILED', {
          ...exec.metadata,
          transitionTaken: {
            outcome: 'FAILURE',
            edge: 'ESCALATE',
          } satisfies TransitionTaken,
        });
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
      attempt = 1;
    }

    // Defensive: an acyclic graph can never reach this, but never loop forever.
    await this.finalizeFailed(runId, cursor, 'walk-exceeded-max-steps');
  }

  // ── step execution + retries ────────────────────────────────────────────────

  /**
   * Execute ONE attempt of a step against its retry policy and classify the outcome (CCOR-3 — the retry
   * backoff is no longer an in-process loop; the walk schedules the next attempt off the worker). Absent
   * `retry` ⇒ a single attempt (`RETRY` is impossible); a `RETRY` is returned only when the handler
   * marked the failure `retryable` AND attempts remain. The walk writes the append-only `WorkflowStepRun`
   * rows; this method is side-effect-free on the ledger (it only runs the handler).
   */
  private async executeStep(
    runId: string,
    step: WorkflowStep,
    index: number,
    ctx: Readonly<WorkflowMappingContext>,
    attempt: number,
  ): Promise<StepOutcome> {
    const handler = this.registry.get(step.kind);
    if (!handler) {
      return {
        status: 'FAILED',
        attempt,
        metadata: {
          errorClass: 'connector-unavailable',
          reason: `no handler for kind ${step.kind}`,
        },
      };
    }

    // Resolve the connector config + credential accessor for this step.
    const resolved = await this.resolveConnection(step);
    if ('error' in resolved) {
      return { status: 'FAILED', attempt, metadata: resolved.error };
    }

    const policy: RetryPolicy =
      'retry' in step && step.retry ? step.retry : DEFAULT_RETRY_POLICY;

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
    if (classified.status === 'AWAITING_INPUT') {
      return {
        status: 'AWAITING_INPUT',
        attempt,
        metadata: classified.metadata,
        manualTaskSpec: raw.manualTask,
      };
    }
    if (classified.status === 'SUCCEEDED') {
      return {
        status: 'SUCCEEDED',
        attempt,
        metadata: classified.metadata,
        externalCorrelationId: classified.externalCorrelationId,
      };
    }
    // FAILED — a retry is due only if the handler signalled retryable and attempts remain.
    if (classified.retryable && attempt < policy.maxAttempts) {
      return {
        status: 'RETRY',
        attempt,
        metadata: classified.metadata,
        retryDelayMs: backoffMs(policy, attempt),
      };
    }
    return { status: 'FAILED', attempt, metadata: classified.metadata };
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

  /**
   * Pause a run for a human: create the PENDING ManualTask, append the pausing step row (stamped with
   * the created task id), and flip the run to AWAITING_INPUT — ALL IN ONE TRANSACTION (CCOR-2). Doing
   * the three writes atomically closes the pause-ordering TOCTOU: there is no window in which the task is
   * resolvable (committed PENDING) while the run is still RUNNING, so a completion can never arrive early
   * and no-op its own resume (which would strand the run AWAITING_INPUT forever). Covers both a MANUAL
   * step's own pause (`spec` carries the prompt/cohort) and an ESCALATED_FAILURE pause (default prompt).
   */
  private async pauseForManual(
    runId: string,
    step: WorkflowStep,
    stepIndex: number,
    attempt: number,
    stepRunStatus: 'AWAITING_INPUT' | 'FAILED',
    metadata: Record<string, unknown>,
    spec?: ManualTaskSpec,
  ): Promise<void> {
    const prompt =
      spec?.prompt ??
      `Step "${step.name ?? step.key}" failed and was escalated for manual handling.`;
    const cohort = spec?.cohort ?? null;
    const taskId = await this.prisma.$transaction(async (tx) => {
      const task = await tx.manualTask.create({
        data: { runId, stepKey: step.key, prompt, cohort, status: 'PENDING' },
      });
      await tx.workflowStepRun.create({
        data: {
          runId,
          stepIndex,
          stepKey: step.key,
          attempt,
          status: stepRunStatus,
          metadata: {
            ...metadata,
            manualTaskId: task.id,
          },
        },
      });
      await tx.workflowRun.update({
        where: { id: runId },
        data: { status: 'AWAITING_INPUT' },
      });
      return task.id;
    });
    // AFTER commit, best-effort: fire the `workflow.manual_task` bell nudge (ADR-0056 §3) — the run
    // paused for a human. NEVER inside the tx (a notification must not roll back the pause); emit
    // swallows its own errors. The deep-link points at the run; the bell row links to the inbox task.
    await this.emitManualTaskNotification(runId, taskId, prompt);
  }

  /**
   * Best-effort POST-COMMIT `workflow.manual_task` bell nudge (ADR-0056 §3) — one per created ManualTask
   * (the dedupe key is `(type, taskId)`, idempotent on a re-fire). Resolves the run's application name
   * for a human title; the entity link points at the run (entityType `workflowRun`), and the web's bell
   * routes the manual-task type to the inbox. Every failure is swallowed — the pause already committed.
   */
  private async emitManualTaskNotification(
    runId: string,
    taskId: string,
    prompt: string,
  ): Promise<void> {
    try {
      const run = await this.prisma.workflowRun.findUnique({
        where: { id: runId },
        select: { application: { select: { name: true } } },
      });
      const appName = run?.application?.name ?? 'a workflow';
      await this.notifications.emit({
        type: 'workflow.manual_task',
        dedupeKey: `workflow.manual_task:${taskId}`,
        severity: 'info',
        title: `A workflow task needs a human — ${appName}`,
        summary: prompt,
        entityType: 'workflowRun',
        entityId: runId,
        metadata: { manualTaskId: taskId, applicationName: appName },
      });
    } catch {
      // Best-effort: a failed nudge never affects the already-committed pause.
    }
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

/**
 * Raised by {@link WorkflowRunOrchestrator.retryRun} when a FAILED run carries no usable failed-step
 * marker (its redacted `error.stepKey` is absent or names a step outside the pinned version). The
 * controller maps it to a 422 — the run is genuinely not resume-from-step retryable. A framework-free
 * domain error so the orchestrator keeps no `@nestjs/common` dependency in its core walk.
 */
export class RetryNotResolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryNotResolvableError';
  }
}

/**
 * Resolve the step key a FAILED run should resume from. Prefers the redacted `error.stepKey` the run
 * carries (set by `finalizeFailed` / the worker's safety-net) when it names a real step in the pinned
 * version; returns `null` when no such marker exists (e.g. an `engine-error` finalize with no step), so
 * the caller can reject the retry cleanly rather than guess an entry-from-start re-run (which could
 * re-execute a non-idempotent SUCCEEDED step). Pure.
 */
export function resolveFailedStepKey(
  error: unknown,
  steps: readonly WorkflowStep[],
): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const stepKey = (error as Record<string, unknown>).stepKey;
  if (typeof stepKey !== 'string' || stepKey.length === 0) {
    return null;
  }
  return steps.some((s) => s.key === stepKey) ? stepKey : null;
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
