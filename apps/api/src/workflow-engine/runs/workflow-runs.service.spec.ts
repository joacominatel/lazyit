jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { WorkflowRunsService } from './workflow-runs.service';
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
  return new WorkflowRunsService(prisma);
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
