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
  type PageQuery,
  type WorkflowRunStatus,
} from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RetryNotResolvableError,
  WorkflowRunOrchestrator,
} from '../run/workflow-run.orchestrator';

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
   */
  async retry(id: string) {
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
      result = await this.orchestrator.retryRun(id);
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
    // deliberately NOT surfaced: it can be a verbatim handler error (`messageOf(err)`) carrying an
    // IP/secret — the BOUNDED `errorClass` is its safe stand-in (CSEC-4).
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
