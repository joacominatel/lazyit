import { Injectable, NotFoundException } from '@nestjs/common';
import {
  offsetOf,
  pageOf,
  type PageQuery,
  type WorkflowRunStatus,
} from '@lazyit/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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
