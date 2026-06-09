jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WorkflowRunsService } from './workflow-runs.service';
import {
  RetryNotResolvableError,
  type WorkflowRunOrchestrator,
} from '../run/workflow-run.orchestrator';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * CSEC-4 — the run-detail projection must surface only an ALLOWLIST of the redacted step `metadata`
 * jsonb (never the whole blob) and a BOUNDED error class. The orchestrator writes diagnostic keys into
 * that jsonb — including a VERBATIM `reason` error string on a handler throw — and the read is gated
 * only by `workflow:read`, so a leak would expose raw errors / unexpected keys to any reader.
 */

// The exact, closed set of keys the projection is allowed to emit per step attempt.
const ALLOWED_KEYS = [
  'id',
  'runId',
  'stepIndex',
  'stepKey',
  'attempt',
  'status',
  'externalCorrelationId',
  'durationMs',
  'statusCode',
  'errorClass',
  'mappedFields',
  'transitionTaken',
  'manualTaskId',
  'compensationStepKey',
  'createdAt',
].sort();

function build(metadata: Record<string, unknown>) {
  const workflowRun = {
    findFirst: jest.fn().mockResolvedValue({ id: 'run1', status: 'FAILED' }),
  };
  const workflowStepRun = {
    findMany: jest.fn().mockResolvedValue([
      {
        id: 1,
        runId: 'run1',
        stepIndex: 0,
        stepKey: 'provision',
        attempt: 2,
        status: 'FAILED',
        externalCorrelationId: null,
        metadata,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]),
  };
  const prisma = {
    workflowRun,
    workflowStepRun,
  } as unknown as PrismaService;
  const orchestrator = {
    retryRun: jest.fn(),
  } as unknown as WorkflowRunOrchestrator;
  return new WorkflowRunsService(prisma, orchestrator);
}

describe('WorkflowRunsService.findOne — CSEC-4 step projection', () => {
  it('emits ONLY the allowlisted keys — no whole metadata, no verbatim error', async () => {
    const service = build({
      durationMs: 12,
      statusCode: 502,
      errorClass: 'http-5xx',
      mappedFields: ['email', 'displayName'],
      transitionTaken: { outcome: 'FAILURE', edge: 'STOP', leak: 'nope' },
      manualTaskId: 'task_1',
      // The danger: a verbatim error string + arbitrary keys that must NEVER escape.
      reason: 'connect ECONNREFUSED 10.0.0.5:443 token=ghp_supersecret',
      requestBody: { password: 'hunter2' },
    });

    const run = await service.findOne('run1');
    const step = run.steps[0] as Record<string, unknown>;

    // The whole jsonb is gone — exactly the allowlist, nothing more.
    expect(Object.keys(step).sort()).toEqual(ALLOWED_KEYS);
    expect(step).not.toHaveProperty('metadata');
    expect(step).not.toHaveProperty('reason');
    expect(step).not.toHaveProperty('requestBody');

    // No value anywhere in the projection carries the verbatim error / secret.
    expect(JSON.stringify(step)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(step)).not.toContain('hunter2');

    // Allowlisted fields are surfaced.
    expect(step.durationMs).toBe(12);
    expect(step.statusCode).toBe(502);
    expect(step.errorClass).toBe('http-5xx');
    expect(step.mappedFields).toEqual(['email', 'displayName']);
    expect(step.manualTaskId).toBe('task_1');
    // transitionTaken is reduced to its closed shape (the foreign `leak` key is dropped).
    expect(step.transitionTaken).toEqual({ outcome: 'FAILURE', edge: 'STOP' });
  });

  it('collapses an unknown / raw error class to OTHER (bounded, never a raw message)', async () => {
    const service = build({
      errorClass: 'Error: connect ECONNREFUSED secret=ghp_abc123',
    });

    const run = await service.findOne('run1');
    const step = run.steps[0] as Record<string, unknown>;

    expect(step.errorClass).toBe('OTHER');
    expect(JSON.stringify(step)).not.toContain('ghp_abc123');
  });

  it('mappedFields keeps only string names; a non-array / absent metadata yields safe defaults', async () => {
    const service = build({ mappedFields: ['ok', 42, { x: 1 }] });

    const run = await service.findOne('run1');
    const step = run.steps[0] as Record<string, unknown>;

    expect(step.mappedFields).toEqual(['ok']);
    expect(step.errorClass).toBeNull();
    expect(step.transitionTaken).toBeNull();
    expect(step.durationMs).toBeNull();
  });
});

/**
 * Issue #308 — the manual post-terminal RETRY of a FAILED run. The service owns the precondition gates
 * (exists / terminal-FAILED) and maps the orchestrator's outcomes to HTTP; the guarded CAS + the
 * resume-from-failed-step walk are the orchestrator's (tested in its own spec).
 */
function buildForRetry(
  runRow: { id: string; status: string } | null,
  retryResult?:
    | { retried: true; resumeStepKey: string; attempt: number }
    | { retried: false }
    | Error,
) {
  const findFirst = jest.fn().mockResolvedValue(runRow);
  const prisma = {
    workflowRun: { findFirst },
    workflowStepRun: { findMany: jest.fn() },
  } as unknown as PrismaService;
  const retryRun = jest.fn(() =>
    retryResult instanceof Error
      ? Promise.reject(retryResult)
      : Promise.resolve(retryResult),
  );
  const orchestrator = {
    retryRun,
  } as unknown as WorkflowRunOrchestrator;
  const service = new WorkflowRunsService(prisma, orchestrator);
  return { service, retryRun };
}

describe('WorkflowRunsService.retry — manual FAILED-run retry (issue #308)', () => {
  it('404s when the run does not exist (never calls the orchestrator)', async () => {
    const { service, retryRun } = buildForRetry(null);
    await expect(service.retry('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(retryRun).not.toHaveBeenCalled();
  });

  it('409s a non-FAILED run — ONLY terminal FAILED is retryable (no full re-run of SUCCEEDED)', async () => {
    for (const status of [
      'PENDING',
      'RUNNING',
      'AWAITING_INPUT',
      'SUCCEEDED',
      'COMPENSATED',
    ]) {
      const { service, retryRun } = buildForRetry({ id: 'r1', status });
      await expect(service.retry('r1')).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The guard short-circuits BEFORE the orchestrator — a COMPENSATED run is never re-driven.
      expect(retryRun).not.toHaveBeenCalled();
    }
  });

  it('retries a FAILED run and returns the resumed step + the new attempt number', async () => {
    const { service, retryRun } = buildForRetry(
      { id: 'r1', status: 'FAILED' },
      { retried: true, resumeStepKey: 'provision', attempt: 3 },
    );
    await expect(service.retry('r1')).resolves.toEqual({
      ok: true,
      runId: 'r1',
      resumeStepKey: 'provision',
      attempt: 3,
    });
    expect(retryRun).toHaveBeenCalledWith('r1');
  });

  it('409s when the guarded CAS is lost to a concurrent retry (orchestrator returns retried: false)', async () => {
    const { service } = buildForRetry(
      { id: 'r1', status: 'FAILED' },
      { retried: false },
    );
    await expect(service.retry('r1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('422s when the FAILED run has no resolvable failed step to resume from', async () => {
    const { service } = buildForRetry(
      { id: 'r1', status: 'FAILED' },
      new RetryNotResolvableError('no failed step'),
    );
    await expect(service.retry('r1')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});
