import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  WORKFLOW_HTTP_METHODS,
  WorkflowStepsSchema,
  type PageQuery,
  type RetryRunOverrides,
  type WorkflowRunStatus,
} from '@lazyit/shared';
import { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ActorService } from '../../common/actor.service';
import type { Principal } from '../../auth/principal';
import {
  assertReplaySafe,
  ReplayNotFailedError,
  RetryNotResolvableError,
  resolveFailedStepKey,
  WorkflowRunOrchestrator,
} from '../run/workflow-run.orchestrator';
import { WorkflowTriggerService } from '../run/workflow-trigger.service';

/** Filters for the run list (C2). All optional; results are newest-first. */
export interface FindRunsFilters {
  applicationId?: string;
  workflowId?: string;
  accessGrantId?: string;
  status?: WorkflowRunStatus;
}

/**
 * Read model for the run observability UI (C2, frontend §7). Lists runs (paginated, newest-first) and
 * returns a run detail = the run + its ORDERED `WorkflowStepRun` attempts, each surfaced with the DAG
 * fields the §7b timeline draws: `transitionTaken` (which edge), plus the escalation/compensation
 * linkage (`manualTaskId` / `compensationStepKey`) read out of the redacted `metadata` jsonb. All bodies
 * are pre-redacted at write time (INV-6) — this read adds no new data, only projection.
 */
@Injectable()
export class WorkflowRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orchestrator: WorkflowRunOrchestrator,
    private readonly trigger: WorkflowTriggerService,
    private readonly actor: ActorService,
  ) {}

  /** A page of runs (newest-first), filtered. Page + count run in one tx so `total` can't drift. */
  async findPage(filters: FindRunsFilters, page: PageQuery) {
    const where = this.buildWhere(filters);
    const { take, skip } = offsetOf(page);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.workflowRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prisma.workflowRun.count({ where }),
    ]);
    return pageOf(items, total, page);
  }

  /** A run + its ordered step attempts (with the projected DAG fields). 404 if missing. */
  async findOne(id: string) {
    const run = await this.prisma.workflowRun.findFirst({ where: { id } });
    if (!run) {
      throw new NotFoundException(`WorkflowRun ${id} not found`);
    }
    const stepRuns = await this.prisma.workflowStepRun.findMany({
      where: { runId: id },
      orderBy: { id: 'asc' },
    });
    return { ...run, steps: stepRuns.map((s) => projectStepRun(s)) };
  }

  /**
   * Manually retry a TERMINAL `FAILED` run from the step that failed onward (issue #308). Gated by
   * `workflow:run` at the route. Validates the precondition (the run exists and is terminal `FAILED`) and
   * delegates the guarded `FAILED`→`RUNNING` CAS + the resume-from-failed-step re-enqueue to the
   * orchestrator. Maps the orchestrator's outcomes to HTTP:
   *   - 404 if the run is missing;
   *   - 409 if it is not terminal `FAILED` (a `SUCCEEDED`/`COMPENSATED`/in-flight run is not retryable —
   *     ONLY `FAILED` is, the §4.9 / issue-308 policy; a COMPENSATED run rolled its effects back and must
   *     be re-granted, not retried), OR if it lost the CAS race (a concurrent retry already claimed it);
   *   - 422 if the FAILED run carries no resolvable failed step to resume from.
   * On success returns the resumed cursor + the new attempt number so the FE can refetch the detail.
   *
   * OPTION 2 (ADR-0057) — an OPTIONAL, request-scoped `overrides` map (validated `RetryRunOverrides`)
   * patches the failed step's data mapping for the NEXT attempt ONLY. It is passed straight through to
   * {@link WorkflowRunOrchestrator.retryRun}, which holds it TRANSIENTLY in memory and discards it after
   * one render — it NEVER touches Valkey / Postgres / the ledger (INV-6). A no-override retry is unchanged.
   */
  async retry(id: string, overrides?: RetryRunOverrides) {
    const run = await this.prisma.workflowRun.findFirst({
      where: { id },
      select: { id: true, status: true },
    });
    if (!run) {
      throw new NotFoundException(`WorkflowRun ${id} not found`);
    }
    if (run.status !== 'FAILED') {
      throw new ConflictException(
        `Only a terminal FAILED run can be retried (this run is ${run.status})`,
      );
    }
    let result: Awaited<ReturnType<WorkflowRunOrchestrator['retryRun']>>;
    try {
      result = await this.orchestrator.retryRun(id, overrides);
    } catch (err) {
      if (err instanceof RetryNotResolvableError) {
        throw new UnprocessableEntityException(
          'This failed run has no resolvable failed step to resume from',
        );
      }
      throw err;
    }
    if (!result.retried) {
      // Lost the guarded CAS to a concurrent retry / the sweeper — surface a clean conflict.
      throw new ConflictException('This run is no longer in a retryable state');
    }
    return {
      ok: true,
      runId: id,
      resumeStepKey: result.resumeStepKey,
      attempt: result.attempt,
    };
  }

  /**
   * Clone-to-new-run from the LATEST workflow version (ADR-0057 Option 3 — the `replay-latest` action,
   * gated `workflow:run`). The stuck source run is left `FAILED` and immutable; a FRESH run is created on
   * the workflow's current version for the SAME (application, accessGrant, trigger), starting at the entry
   * node and enqueued through the SAME normal fire path the worker uses — NOT a resume. This closes the
   * "fixed the flow, now make this run go through" loop without re-pinning, ledger rewrite or a transient-
   * PII channel (the override is the separate Option-2 path on `retry`).
   *
   *   1. Load the source run. It MUST be terminal `FAILED` (→ {@link ReplayNotFailedError} → 409) and MUST
   *      carry a grant id (a replay re-fires a grant event; a grant-less run has nothing to re-fire).
   *   2. Resolve the LATEST version via {@link WorkflowTriggerService.planForTrigger} (NEVER re-implement
   *      version selection) — this is the version the clone will execute.
   *   3. FAIL-CLOSED double-provision guard (the security-critical gate, ADR-0057 Decision 3, #555): refuse
   *      if the source run already SUCCEEDED a NON-idempotent create on/before the failed step, evaluated
   *      against the LATEST version's step definitions (what re-fires), NOT the source's pinned version
   *      ({@link assertReplaySafe} → {@link ReplayNotIdempotentError} → 422). No warn-and-proceed.
   *   4. Compute `seq = max(replaySeq for this (trigger, accessGrantId)) + 1`, build the new PENDING run via
   *      {@link WorkflowTriggerService.buildReplayRunData} (the parent's id as `supersedesRunId`), CREATE
   *      it, and enqueue via the normal {@link WorkflowTriggerService.enqueue}.
   *
   * Idempotency-key race: two concurrent replays can compute the same `seq`; the unique `idempotencyKey`
   * makes the second `create` throw P2002. We catch it and retry with a freshly-recomputed `seq` (bounded);
   * if it still loses, we surface a clean 409 — never a 500.
   */
  async replayLatest(runId: string, principal?: Principal) {
    const source = await this.prisma.workflowRun.findFirst({
      where: { id: runId },
    });
    if (!source) {
      throw new NotFoundException(`WorkflowRun ${runId} not found`);
    }
    if (source.status !== 'FAILED') {
      throw new ReplayNotFailedError(
        `Only a terminal FAILED run can be replayed on the latest version (this run is ${source.status})`,
      );
    }
    if (!source.accessGrantId) {
      // A replay re-fires a GRANT event onto the latest version; with no grant there is nothing to re-fire.
      throw new UnprocessableEntityException(
        'This run has no access grant to replay; re-grant to run the latest workflow version',
      );
    }
    const accessGrantId = source.accessGrantId;

    // Resolve the LATEST version for this (application, trigger) — the SAME selection a real grant uses —
    // BEFORE the guard, because the clone re-fires THAT version (not the source's pinned one).
    const plan = await this.trigger.planForTrigger(
      source.trigger,
      source.applicationId,
    );
    if (!plan) {
      // The workflow was disabled / deleted, or lost its last version, since the source run fired.
      throw new UnprocessableEntityException(
        'No enabled workflow version exists to replay this run against',
      );
    }

    // FAIL-CLOSED guard (ADR-0057 Decision 3, #555). The clone re-fires the LATEST version from the entry
    // node, so the double-provision hazard is defined by the LATEST version's step definitions — NOT the
    // source run's pinned version. Evaluate the guard against the latest steps: a step that the source run
    // already SUCCEEDED (matched by stable `stepKey`) and that is a NON-idempotent provisioning step in
    // the latest version would double-provision on re-fire. (A step idempotent-in-source-but-not-in-latest
    // is now correctly caught; a step removed from the latest version is correctly skipped.)
    const latest = await this.prisma.workflowVersion.findUnique({
      where: { id: plan.workflowVersionId },
      select: { steps: true },
    });
    if (!latest) {
      // The resolved version vanished between planForTrigger and this read — treat as "nothing to run".
      throw new UnprocessableEntityException(
        'No enabled workflow version exists to replay this run against',
      );
    }
    const steps = WorkflowStepsSchema.parse(latest.steps);
    const failedStepKey = resolveFailedStepKey(source.error, steps);
    const succeeded = await this.prisma.workflowStepRun.findMany({
      where: { runId, status: 'SUCCEEDED' },
      select: { stepKey: true },
    });
    // Throws ReplayNotIdempotentError (→ 422) when unsafe; returns when every completed provisioning step
    // up to and including the failed step is idempotent.
    assertReplaySafe(steps, failedStepKey, succeeded);

    const actor = this.actor.resolveActor(principal);

    // Create + enqueue, retrying the seq on a unique-key race (a concurrent replay took the same seq).
    const created = await this.createReplayRun(
      plan,
      accessGrantId,
      actor,
      runId,
    );
    await this.trigger.enqueue(created.id);
    return {
      ok: true as const,
      runId: created.id,
      supersedesRunId: runId,
      workflowVersionId: created.workflowVersionId,
      replaySeq: created.replaySeq,
    };
  }

  /**
   * Compute `seq` and create the replay run, retrying on a unique `idempotencyKey` collision (a concurrent
   * replay that grabbed the same seq). Bounded attempts; a persistent loser surfaces a clean 409 rather
   * than a 500. The seq is `max(replaySeq) + 1` over ALL runs for this (trigger, accessGrantId) — so the
   * organic seq-0 run and every prior replay are accounted for.
   */
  private async createReplayRun(
    plan: Awaited<ReturnType<WorkflowTriggerService['planForTrigger']>> & object,
    accessGrantId: string,
    actor: ReturnType<ActorService['resolveActor']>,
    supersedesRunId: string,
  ) {
    const MAX_SEQ_ATTEMPTS = 5;
    for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt++) {
      const highest = await this.prisma.workflowRun.findFirst({
        where: { trigger: plan.trigger, accessGrantId },
        orderBy: { replaySeq: 'desc' },
        select: { replaySeq: true },
      });
      const seq = (highest?.replaySeq ?? 0) + 1;
      try {
        return await this.prisma.workflowRun.create({
          data: this.trigger.buildReplayRunData(
            plan,
            accessGrantId,
            actor,
            seq,
            supersedesRunId,
          ),
          select: { id: true, workflowVersionId: true, replaySeq: true },
        });
      } catch (err) {
        // P2002 = the unique idempotencyKey was taken by a concurrent replay between our read and write.
        // Recompute the seq and try again; any other error propagates.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }
    throw new ConflictException(
      'Could not allocate a replay sequence — a concurrent replay is in progress; retry',
    );
  }

  private buildWhere(filters: FindRunsFilters): Prisma.WorkflowRunWhereInput {
    return {
      ...(filters.applicationId
        ? { applicationId: filters.applicationId }
        : {}),
      ...(filters.workflowId ? { workflowId: filters.workflowId } : {}),
      ...(filters.accessGrantId
        ? { accessGrantId: filters.accessGrantId }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
  }
}

/**
 * The CLOSED vocabulary of step error classes the engine records (orchestrator + the v1 handlers /
 * egress classifier). Any value outside it — including a future raw/verbatim string a handler might
 * mis-set — collapses to `OTHER`, so the read can never surface an unbounded error token (CSEC-4).
 */
const KNOWN_ERROR_CLASSES: ReadonlySet<string> = new Set([
  'step-failed',
  'connector-unavailable',
  'handler-threw',
  'config',
  'engine-error',
  'egress-blocked',
  'timeout',
  'network',
  'http-4xx',
  'http-5xx',
  'http-other',
]);
const KNOWN_TRANSITION_OUTCOMES: ReadonlySet<string> = new Set([
  'SUCCESS',
  'FAILURE',
  'PAUSE',
]);
const KNOWN_TRANSITION_EDGES: ReadonlySet<string> = new Set([
  'NEXT',
  'GOTO',
  'END',
  'CONTINUE',
  'ESCALATE',
  'COMPENSATE',
  'STOP',
  'PAUSE',
]);

/** Bound the recorded error class to the closed taxonomy; unknown non-empty values → `OTHER`. */
function boundErrorClass(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return KNOWN_ERROR_CLASSES.has(value) ? value : 'OTHER';
}

/** The closed HTTP-method vocabulary the handlers record (`GET`…`DELETE`). */
const KNOWN_HTTP_METHODS: ReadonlySet<string> = new Set(WORKFLOW_HTTP_METHODS);

/**
 * Bound the recorded request method to the closed HTTP-method set — same CSEC-4 discipline as
 * `boundErrorClass`: a handler only ever writes a value from the enum, but the read still refuses any
 * out-of-vocabulary token (defence in depth) rather than surface a raw string. `null` when absent.
 */
function boundMethod(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  return KNOWN_HTTP_METHODS.has(value) ? value : null;
}

/** The closed projected transition shape — fixed-vocabulary outcome/edge + an optional target key. */
export interface ProjectedTransition {
  outcome: string | null;
  edge: string | null;
  targetStepKey?: string;
}

/**
 * Project `metadata.transitionTaken` to its closed shape ONLY (outcome / edge from the fixed
 * vocabularies + the target step key) — never the raw jsonb. Returns null when it is absent or not a
 * recognisable transition, so no arbitrary nested object can ride out through this field.
 */
function projectTransition(value: unknown): ProjectedTransition | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const t = value as Record<string, unknown>;
  const outcome =
    typeof t.outcome === 'string' && KNOWN_TRANSITION_OUTCOMES.has(t.outcome)
      ? t.outcome
      : null;
  const edge =
    typeof t.edge === 'string' && KNOWN_TRANSITION_EDGES.has(t.edge)
      ? t.edge
      : null;
  if (outcome === null && edge === null) {
    return null;
  }
  return {
    outcome,
    edge,
    ...(typeof t.targetStepKey === 'string'
      ? { targetStepKey: t.targetStepKey }
      : {}),
  };
}

/**
 * Project a step attempt to the C2 wire shape — an ALLOWLIST of the redacted `metadata` jsonb, NEVER
 * the whole blob (CSEC-4). The orchestrator writes diagnostic-but-potentially-sensitive keys into that
 * jsonb (e.g. a verbatim `reason` error string on a handler throw); the run-detail read is gated only
 * by `workflow:read`, so it must surface ONLY the bounded DAG/observability fields the §7b timeline
 * needs and a BOUNDED error class — no raw error message, no unexpected key, escapes.
 *
 * The REQUEST SHAPE (issue #343) is part of that allowlist: the bounded `method` + the `targetHost`
 * (host only, never the full URL with query) + the `mappedFields` NAMES (never their values) — enough
 * to answer "which method + host did this hit, and which fields did it map?" while honouring INV-6. The
 * verbatim `reason` stays OUT (its bounded twin `errorClass` is surfaced instead).
 */
function projectStepRun(s: {
  id: number;
  runId: string;
  stepIndex: number;
  stepKey: string;
  attempt: number;
  status: string;
  externalCorrelationId: string | null;
  metadata: unknown;
  createdAt: Date;
}) {
  const meta = (s.metadata ?? {}) as Record<string, unknown>;
  return {
    id: s.id,
    runId: s.runId,
    stepIndex: s.stepIndex,
    stepKey: s.stepKey,
    attempt: s.attempt,
    status: s.status,
    externalCorrelationId: s.externalCorrelationId,
    durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null,
    statusCode: typeof meta.statusCode === 'number' ? meta.statusCode : null,
    // The request SHAPE — the bounded HTTP method + the target HOST only (never the full URL with its
    // query, which can carry a secret; the handlers record `redactHost(url)`, INV-6). `reason` is
    // deliberately NOT surfaced: persisted `reason` values are bounded literals (the orchestrator drops
    // any raw handler-throw message at the write boundary, INV-6), but the BOUNDED `errorClass` is its
    // safe stand-in here regardless (CSEC-4).
    method: boundMethod(meta.method),
    targetHost: typeof meta.targetHost === 'string' ? meta.targetHost : null,
    errorClass: boundErrorClass(meta.errorClass),
    // The NAMES of the mapped fields that were sent — never their values (the handler only records
    // keys, INV-6). Filtered to strings so no foreign jsonb rides along.
    mappedFields: Array.isArray(meta.mappedFields)
      ? meta.mappedFields.filter((f): f is string => typeof f === 'string')
      : [],
    transitionTaken: projectTransition(meta.transitionTaken),
    manualTaskId:
      typeof meta.manualTaskId === 'string' ? meta.manualTaskId : null,
    compensationStepKey:
      typeof meta.compensationStepKey === 'string'
        ? meta.compensationStepKey
        : null,
    createdAt: s.createdAt,
  };
}
