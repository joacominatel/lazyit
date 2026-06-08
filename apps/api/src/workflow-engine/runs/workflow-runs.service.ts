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

/** Surface the DAG fields stored in the redacted `metadata` jsonb at the top level of a step attempt. */
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
    errorClass: typeof meta.errorClass === 'string' ? meta.errorClass : null,
    transitionTaken: meta.transitionTaken ?? null,
    manualTaskId:
      typeof meta.manualTaskId === 'string' ? meta.manualTaskId : null,
    compensationStepKey:
      typeof meta.compensationStepKey === 'string'
        ? meta.compensationStepKey
        : null,
    metadata: meta,
    createdAt: s.createdAt,
  };
}
