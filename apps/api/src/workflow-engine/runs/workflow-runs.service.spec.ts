jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  // The service catches a P2002 unique-violation via `instanceof Prisma.PrismaClientKnownRequestError`
  // + `err.code === 'P2002'`; mock the class so the race test can construct a matching error.
  Prisma: {
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, opts: { code: string }) {
        super(message);
        this.code = opts.code;
      }
    },
  },
}));

import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { WorkflowRunsService } from './workflow-runs.service';
import {
  ReplayNotFailedError,
  ReplayNotIdempotentError,
  RetryNotResolvableError,
  type WorkflowRunOrchestrator,
} from '../run/workflow-run.orchestrator';
import type { WorkflowTriggerService } from '../run/workflow-trigger.service';
import type { ActorService } from '../../common/actor.service';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/** A stub ActorService that resolves a human principal to `{ userId }` (the ADR-0048 mapping). */
const actorStub = {
  resolveActor: jest.fn().mockReturnValue({ userId: 'admin-1' }),
} as unknown as ActorService;

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
  'method',
  'targetHost',
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
  const trigger = {} as unknown as WorkflowTriggerService;
  return new WorkflowRunsService(prisma, orchestrator, trigger, actorStub);
}

describe('WorkflowRunsService.findOne — CSEC-4 step projection', () => {
  it('emits ONLY the allowlisted keys — no whole metadata, no verbatim error', async () => {
    const service = build({
      durationMs: 12,
      statusCode: 502,
      method: 'POST',
      targetHost: 'api.jira.example.com',
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
    // The request SHAPE (issue #343): bounded method + the host only (never a full URL with query).
    expect(step.method).toBe('POST');
    expect(step.targetHost).toBe('api.jira.example.com');
    expect(step.errorClass).toBe('http-5xx');
    expect(step.mappedFields).toEqual(['email', 'displayName']);
    expect(step.manualTaskId).toBe('task_1');
    // transitionTaken is reduced to its closed shape (the foreign `leak` key is dropped).
    expect(step.transitionTaken).toEqual({ outcome: 'FAILURE', edge: 'STOP' });
  });

  it('bounds the request method to the HTTP-method set — an out-of-vocabulary token collapses to null', async () => {
    const service = build({
      method: 'CONNECT secret=ghp_xyz',
      targetHost: 'api.example.com',
    });

    const run = await service.findOne('run1');
    const step = run.steps[0] as Record<string, unknown>;

    // A non-enum method never rides out as a raw string (CSEC-4 defence in depth).
    expect(step.method).toBeNull();
    expect(JSON.stringify(step)).not.toContain('ghp_xyz');
    // …while a legitimate host-only target is surfaced unchanged.
    expect(step.targetHost).toBe('api.example.com');
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
    expect(step.method).toBeNull();
    expect(step.targetHost).toBeNull();
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
  const trigger = {} as unknown as WorkflowTriggerService;
  const service = new WorkflowRunsService(
    prisma,
    orchestrator,
    trigger,
    actorStub,
  );
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
    expect(retryRun).toHaveBeenCalledWith('r1', undefined);
  });

  it('threads the OPTIONAL overrides straight through to the orchestrator (ADR-0057 Option 2)', async () => {
    const { service, retryRun } = buildForRetry(
      { id: 'r1', status: 'FAILED' },
      { retried: true, resumeStepKey: 'provision', attempt: 2 },
    );
    const overrides = { lastName: '{{ grantee.lastName }}' };
    await service.retry('r1', overrides);
    // The service is a pass-through for the transient override; the orchestrator holds it in memory.
    expect(retryRun).toHaveBeenCalledWith('r1', overrides);
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

/**
 * ADR-0057 Option 3 — clone-to-new-run from the LATEST version (`replay-latest`). The service leaves the
 * source FAILED run immutable, runs the FAIL-CLOSED double-provision guard, resolves the latest version
 * via the trigger service, computes the next replay seq, and enqueues a fresh run via the normal fire path.
 */

/** A valid cuid for a step's connectionId (the shared step schema enforces z.cuid()). */
const CONN = 'cjld2cjxh0000qzrmn831i7rn';
const restStep = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'REST',
  key,
  connectionId: CONN,
  method: 'POST',
  path: `/${key}`,
  ...extra,
});

interface ReplayHarnessOpts {
  source?: Record<string, unknown> | null;
  steps?: unknown[];
  succeeded?: Array<{ stepKey: string }>;
  /** The highest existing replaySeq for (trigger, accessGrantId); the next run gets +1. */
  maxReplaySeq?: number | null;
  plan?: Record<string, unknown> | null;
  /** When set, `create` throws this many P2002 collisions before succeeding (the seq race). */
  collisionsBeforeSuccess?: number;
}

function buildForReplay(opts: ReplayHarnessOpts = {}) {
  const source =
    opts.source === undefined
      ? {
          id: 'src',
          status: 'FAILED',
          trigger: 'ACCESS_GRANTED',
          applicationId: 'cjld2cjxh0000qzrmn831i7rn',
          accessGrantId: 'cjld2cjxh0001qzrmn831i7rn',
          error: { stepKey: 's2', errorClass: 'step-failed' },
          workflowVersion: {
            steps: opts.steps ?? [
              restStep('s1', { idempotent: true }),
              restStep('s2', { idempotent: false }),
            ],
          },
        }
      : opts.source;

  const findFirst = jest.fn(
    async (args: { orderBy?: { replaySeq?: string } }) => {
      // The seq query (orderBy replaySeq desc) vs the initial source load (include workflowVersion).
      if (args.orderBy?.replaySeq === 'desc') {
        return opts.maxReplaySeq == null
          ? null
          : { replaySeq: opts.maxReplaySeq };
      }
      return source;
    },
  );

  // create() optionally throws N P2002 collisions, then returns the new run. The returned seq mirrors what
  // buildReplayRunData computed (read off the create data).
  let creates = 0;
  const create = jest.fn(
    async (args: { data: { replaySeq: number; supersedesRunId: string } }) => {
      if (creates < (opts.collisionsBeforeSuccess ?? 0)) {
        creates += 1;
        throw new Prisma.PrismaClientKnownRequestError('unique', {
          code: 'P2002',
        });
      }
      return {
        id: 'new-run',
        workflowVersionId: 99,
        replaySeq: args.data.replaySeq,
      };
    },
  );

  const findManyStepRuns = jest.fn().mockResolvedValue(opts.succeeded ?? []);
  const prisma = {
    workflowRun: { findFirst, create },
    workflowStepRun: { findMany: findManyStepRuns },
  } as unknown as PrismaService;

  const orchestrator = { retryRun: jest.fn() } as unknown as WorkflowRunOrchestrator;

  const plan =
    opts.plan === undefined
      ? {
          workflowId: 'wf1',
          workflowVersionId: 99,
          applicationId: 'cjld2cjxh0000qzrmn831i7rn',
          trigger: 'ACCESS_GRANTED',
          executedAsServiceAccountId: null,
          deprovisionPolicy: 'LAST_ACTIVE_GRANT',
        }
      : opts.plan;

  const enqueue = jest.fn().mockResolvedValue(true);
  const buildReplayRunData = jest.fn(
    (
      p: { workflowId: string; workflowVersionId: number; applicationId: string; trigger: string },
      accessGrantId: string,
      _actor: unknown,
      seq: number,
      supersedesRunId: string,
    ) => ({
      workflowId: p.workflowId,
      workflowVersionId: p.workflowVersionId,
      applicationId: p.applicationId,
      trigger: p.trigger,
      accessGrantId,
      replaySeq: seq,
      idempotencyKey: `${p.trigger}:${accessGrantId}:${seq}`,
      supersedesRunId,
      status: 'PENDING',
    }),
  );
  const trigger = {
    planForTrigger: jest.fn().mockResolvedValue(plan),
    buildReplayRunData,
    enqueue,
  } as unknown as WorkflowTriggerService;

  const service = new WorkflowRunsService(
    prisma,
    orchestrator,
    trigger,
    actorStub,
  );
  return { service, prisma, trigger, enqueue, create, buildReplayRunData };
}

describe('WorkflowRunsService.replayLatest — clone-to-new-run (ADR-0057 Option 3)', () => {
  it('creates a NEW run on the LATEST version with replaySeq = prev+1 and supersedesRunId set; enqueues via the normal path', async () => {
    const { service, trigger, enqueue, create, buildReplayRunData } =
      buildForReplay({ maxReplaySeq: 0 });

    const res = await service.replayLatest('src');

    // The result points at the new run + records the lineage.
    expect(res).toEqual({
      ok: true,
      runId: 'new-run',
      supersedesRunId: 'src',
      workflowVersionId: 99,
      replaySeq: 1, // prev (0, the organic grant run) + 1
    });
    // The latest version is resolved via the trigger service (never re-implemented here).
    expect(trigger.planForTrigger).toHaveBeenCalledWith(
      'ACCESS_GRANTED',
      'cjld2cjxh0000qzrmn831i7rn',
    );
    // The new run carries seq 1 + the parent as supersedesRunId.
    const callArgs = (buildReplayRunData as jest.Mock).mock.calls[0];
    expect(callArgs[3]).toBe(1); // seq
    expect(callArgs[4]).toBe('src'); // supersedesRunId
    // It is enqueued via the SAME normal fire path the worker uses (start job), NOT a resume/retry.
    expect(enqueue).toHaveBeenCalledWith('new-run');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('computes the next seq above the HIGHEST existing replay (prev replay seq 3 → new seq 4)', async () => {
    const { service, buildReplayRunData } = buildForReplay({ maxReplaySeq: 3 });
    const res = await service.replayLatest('src');
    expect(res).toMatchObject({ replaySeq: 4 });
    expect((buildReplayRunData as jest.Mock).mock.calls[0][3]).toBe(4);
  });

  it('NEVER mutates the source run (no update/delete on the FAILED run — append-only)', async () => {
    const { service, prisma } = buildForReplay({ maxReplaySeq: 0 });
    await service.replayLatest('src');
    // The only writes are the CREATE of the new run; the source run is read-only here.
    expect(
      (prisma.workflowRun as unknown as { update?: unknown }).update,
    ).toBeUndefined();
    expect(
      (prisma.workflowRun as unknown as { updateMany?: unknown }).updateMany,
    ).toBeUndefined();
  });

  it('404s when the source run does not exist', async () => {
    const { service } = buildForReplay({ source: null });
    await expect(service.replayLatest('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('throws ReplayNotFailedError (→ 409) when the source run is NOT terminal FAILED', async () => {
    for (const status of [
      'PENDING',
      'RUNNING',
      'AWAITING_INPUT',
      'SUCCEEDED',
      'COMPENSATED',
    ]) {
      const { service, create } = buildForReplay({
        source: {
          id: 'src',
          status,
          trigger: 'ACCESS_GRANTED',
          applicationId: 'cjld2cjxh0000qzrmn831i7rn',
          accessGrantId: 'cjld2cjxh0001qzrmn831i7rn',
          error: null,
          workflowVersion: { steps: [restStep('s1', { idempotent: true })] },
        },
      });
      await expect(service.replayLatest('src')).rejects.toBeInstanceOf(
        ReplayNotFailedError,
      );
      // Never creates a clone for a non-FAILED source.
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('FAIL-CLOSED guard REFUSES (ReplayNotIdempotentError → 422) when a non-idempotent create already SUCCEEDED on/before the failed step', async () => {
    const { service, create } = buildForReplay({
      // s1 is a NON-idempotent create that already SUCCEEDED; the run failed at s2.
      steps: [restStep('s1', { idempotent: false }), restStep('s2')],
      succeeded: [{ stepKey: 's1' }],
    });
    await expect(service.replayLatest('src')).rejects.toBeInstanceOf(
      ReplayNotIdempotentError,
    );
    // Refused BEFORE any clone is created — the operator must re-grant instead.
    expect(create).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED guard ALLOWS when every completed provisioning step up to the failed step is idempotent', async () => {
    const { service, create } = buildForReplay({
      // s1 SUCCEEDED but is idempotent → re-firing it is safe; the run failed at s2.
      steps: [
        restStep('s1', { idempotent: true }),
        restStep('s2', { idempotent: false }),
      ],
      succeeded: [{ stepKey: 's1' }],
      maxReplaySeq: 0,
    });
    await expect(service.replayLatest('src')).resolves.toMatchObject({
      ok: true,
      replaySeq: 1,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('survives the seq-allocation RACE: a P2002 unique-violation recomputes the seq and retries (never a 500)', async () => {
    const { service, create } = buildForReplay({
      maxReplaySeq: 0,
      collisionsBeforeSuccess: 2, // two concurrent replays grabbed the seq first
    });
    const res = await service.replayLatest('src');
    expect(res).toMatchObject({ ok: true, runId: 'new-run' });
    // It retried the create until it won (2 collisions + 1 success).
    expect(create).toHaveBeenCalledTimes(3);
  });

  it('surfaces a clean ConflictException (409) — never a 500 — when the seq race never resolves', async () => {
    const { service } = buildForReplay({
      maxReplaySeq: 0,
      collisionsBeforeSuccess: 99, // it can never win
    });
    await expect(service.replayLatest('src')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('422s when no enabled workflow version exists to replay against (planForTrigger returns null)', async () => {
    const { service, create } = buildForReplay({
      plan: null,
      maxReplaySeq: 0,
    });
    await expect(service.replayLatest('src')).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
