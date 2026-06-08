jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  realSleeper,
  WorkflowRunOrchestrator,
  backoffMs,
  type Sleeper,
} from './workflow-run.orchestrator';
import type { StepResult } from '../handlers/step-handler';

/** A throwaway but VALID cuid for a step's connectionId (the shared step schema enforces z.cuid()). */
const CONN = 'cjld2cjxh0000qzrmn831i7rn';

/** A connector handler that returns a scripted sequence of results (one per execute() call). */
function scripted(kind: string, results: StepResult[]) {
  let i = 0;
  return {
    kind,
    execute: jest.fn(async () => {
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return r;
    }),
  };
}

/**
 * Build an in-memory orchestrator + a mock Prisma that records appended step runs, run updates and
 * created manual tasks, and tracks the run status through the guarded transitions. `steps` is the raw
 * (pre-parse) version graph; the orchestrator parses it with the shared schema.
 */
function harness(
  steps: unknown[],
  handlers: Record<string, ReturnType<typeof scripted>>,
) {
  const state = {
    runStatus: 'PENDING' as string,
    stepRuns: [] as Array<Record<string, unknown>>,
    runUpdates: [] as Array<Record<string, unknown>>,
    manualTasks: [] as Array<Record<string, unknown>>,
  };

  const prisma = {
    workflowRun: {
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { status: string };
          data: { status: string };
        }) => {
          if (where.status === state.runStatus) {
            state.runStatus = data.status;
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      findFirst: jest.fn(async () => ({
        id: 'run1',
        status: state.runStatus,
        trigger: 'ACCESS_GRANTED',
        workflowVersion: { steps },
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.runUpdates.push(data);
        if (typeof data.status === 'string') {
          state.runStatus = data.status;
        }
        return {};
      }),
    },
    workflowStepRun: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: state.stepRuns.length + 1, ...data };
        state.stepRuns.push(row);
        return row;
      }),
      findMany: jest.fn(async () =>
        state.stepRuns.filter((s) => s.status === 'SUCCEEDED'),
      ),
    },
    manualTask: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const t = { id: `task${state.manualTasks.length + 1}`, ...data };
        state.manualTasks.push(t);
        return t;
      }),
    },
    workflowConnection: {
      findFirst: jest.fn(async () => ({
        id: CONN,
        kind: 'REST',
        secretId: null,
        config: {
          kind: 'REST',
          baseUrl: 'https://api.test',
          authScheme: 'NONE',
        },
      })),
    },
  };

  const registry = { get: (kind: string) => handlers[kind] };
  const secrets = { revealById: jest.fn() };
  const contextBuilder = {
    build: jest.fn(async () =>
      Object.freeze({
        event: 'ACCESS_GRANTED',
        grantee: { id: 'u1', email: 'a@b.test', firstName: 'A', lastName: 'B' },
        application: { id: 'app1', name: 'App' },
        grant: {
          id: 'g1',
          accessLevel: null,
          grantedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
        steps: {},
      }),
    ),
  };
  const sleeper: Sleeper = { sleep: jest.fn().mockResolvedValue(undefined) };

  const orchestrator = new WorkflowRunOrchestrator(
    prisma as never,
    registry as never,
    secrets as never,
    contextBuilder as never,
    sleeper,
  );
  return { orchestrator, prisma, state, sleeper };
}

const restStep = (key: string, extra: Record<string, unknown> = {}) => ({
  kind: 'REST',
  key,
  connectionId: CONN,
  method: 'POST',
  path: `/${key}`,
  ...extra,
});

const ok = (statusCode = 200): StepResult => ({
  status: 'SUCCEEDED',
  externalCorrelationId: 'ext-1',
  metadata: { statusCode },
});
const failPermanent = (statusCode = 500): StepResult => ({
  status: 'FAILED',
  retryable: false,
  metadata: { statusCode },
});
const failTransient = (statusCode = 503): StepResult => ({
  status: 'FAILED',
  retryable: true,
  metadata: { statusCode },
});

describe('WorkflowRunOrchestrator — the DAG walk (ADR-0054 §8)', () => {
  it('SUCCESS edge: a linear two-step flow runs each step then ends SUCCEEDED', async () => {
    const { orchestrator, state } = harness([restStep('s1'), restStep('s2')], {
      REST: scripted('REST', [ok(), ok()]),
    });

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('SUCCEEDED');
    const succeeded = state.stepRuns.filter((s) => s.status === 'SUCCEEDED');
    expect(succeeded).toHaveLength(2);
    // The first step's success edge is NEXT(s2); the second's is END.
    expect(
      (succeeded[0].metadata as Record<string, unknown>).transitionTaken,
    ).toMatchObject({
      outcome: 'SUCCESS',
      edge: 'NEXT',
      targetStepKey: 's2',
    });
    expect(
      (succeeded[1].metadata as Record<string, unknown>).transitionTaken,
    ).toMatchObject({
      outcome: 'SUCCESS',
      edge: 'END',
    });
    // The captured external correlation id rides the success row.
    expect(succeeded[0].externalCorrelationId).toBe('ext-1');
  });

  it('re-classifies a non-2xx as SUCCESS when the step declares it in successCriteria', async () => {
    const { orchestrator, state } = harness(
      [restStep('s1', { successCriteria: { statuses: [404] } })],
      { REST: scripted('REST', [failPermanent(404)]) },
    );

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('SUCCEEDED');
  });

  it('FAILURE → STOP_FAIL: a permanent failure with the default failure edge ends the run FAILED', async () => {
    const { orchestrator, state } = harness([restStep('s1')], {
      REST: scripted('REST', [failPermanent(500)]),
    });

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('FAILED');
    const failed = state.stepRuns.find((s) => s.status === 'FAILED');
    expect(
      (failed!.metadata as Record<string, unknown>).transitionTaken,
    ).toMatchObject({
      outcome: 'FAILURE',
      edge: 'STOP',
    });
    // A redacted error summary (step key + class) lands on the run, never a body.
    const finalize = state.runUpdates.find((u) => u.status === 'FAILED');
    expect(finalize!.error).toMatchObject({ stepKey: 's1' });
  });

  it('FAILURE → ESCALATE_TO_MANUAL: pauses the run AWAITING_INPUT with a ManualTask (no job in flight)', async () => {
    const { orchestrator, state } = harness(
      [restStep('s1', { onFailure: 'ESCALATE_TO_MANUAL' })],
      { REST: scripted('REST', [failPermanent(500)]) },
    );

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('AWAITING_INPUT');
    expect(state.manualTasks).toHaveLength(1);
    const failed = state.stepRuns.find((s) => s.status === 'FAILED');
    expect(
      (failed!.metadata as Record<string, unknown>).transitionTaken,
    ).toMatchObject({
      outcome: 'FAILURE',
      edge: 'ESCALATE',
    });
    expect((failed!.metadata as Record<string, unknown>).manualTaskId).toBe(
      'task1',
    );
  });

  it('FAILURE → COMPENSATE: appends COMPENSATED rows for succeeded steps (reverse) and ends COMPENSATED', async () => {
    const { orchestrator, state } = harness(
      [restStep('s1'), restStep('s2', { onFailure: 'COMPENSATE' })],
      { REST: scripted('REST', [ok(), failPermanent(500)]) },
    );

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('COMPENSATED');
    // s1 SUCCEEDED, s2 FAILED(COMPENSATE), then a COMPENSATED row for s1.
    const compensated = state.stepRuns.filter(
      (s) => s.status === 'COMPENSATED',
    );
    expect(compensated).toHaveLength(1);
    expect(compensated[0].stepKey).toBe('s1');
  });

  it('retries a transient failure per step.retry, then succeeds (one row per attempt)', async () => {
    const { orchestrator, state, sleeper } = harness(
      [
        restStep('s1', {
          retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 0 },
        }),
      ],
      { REST: scripted('REST', [failTransient(503), ok()]) },
    );

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('SUCCEEDED');
    // Two attempts → two append-only rows (attempt 1 FAILED, attempt 2 SUCCEEDED).
    expect(state.stepRuns).toHaveLength(2);
    expect(state.stepRuns[0]).toMatchObject({ attempt: 1, status: 'FAILED' });
    expect(state.stepRuns[1]).toMatchObject({
      attempt: 2,
      status: 'SUCCEEDED',
    });
    expect(sleeper.sleep).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-idempotent permanent failure (single attempt)', async () => {
    const { orchestrator, state } = harness(
      [
        restStep('s1', {
          retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 0 },
        }),
      ],
      { REST: scripted('REST', [failPermanent(400)]) },
    );

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('FAILED');
    expect(state.stepRuns).toHaveLength(1);
  });

  it('MANUAL step: pauses AWAITING_INPUT, then resume() continues from onSuccess to END', async () => {
    const steps = [
      {
        kind: 'MANUAL',
        key: 'm1',
        prompt: 'Pick a team for {{ grantee.email }}',
        inputFields: [{ name: 'team', label: 'Team', type: 'text' }],
      },
      restStep('s2'),
    ];
    const manual = {
      kind: 'MANUAL',
      execute: jest.fn(async () => ({
        status: 'AWAITING_INPUT' as const,
        manualTask: { stepKey: 'm1', prompt: 'Pick a team', inputFields: [] },
      })),
    };
    const { orchestrator, state } = harness(steps, {
      MANUAL: manual,
      REST: scripted('REST', [ok()]),
    });

    await orchestrator.start('run1');
    expect(state.runStatus).toBe('AWAITING_INPUT');
    expect(state.manualTasks).toHaveLength(1);

    // Resume at the manual step's onSuccess (the next step s2).
    await orchestrator.resume('run1', 's2');
    expect(state.runStatus).toBe('SUCCEEDED');
  });

  it('start() is idempotent: a second start of an already-RUNNING run is a no-op', async () => {
    const { orchestrator, prisma, state } = harness([restStep('s1')], {
      REST: scripted('REST', [ok()]),
    });

    await orchestrator.start('run1'); // PENDING → RUNNING → SUCCEEDED
    const stepRunsAfterFirst = state.stepRuns.length;
    (prisma.workflowRun.findFirst as jest.Mock).mockClear();

    await orchestrator.start('run1'); // status is now SUCCEEDED → claim fails → no-op
    expect(state.stepRuns.length).toBe(stepRunsAfterFirst);
  });
});

describe('backoffMs', () => {
  it('fixed backoff returns the base delay', () => {
    expect(
      backoffMs({ maxAttempts: 3, backoff: 'fixed', delayMs: 500 }, 2),
    ).toBe(500);
  });
  it('exponential backoff doubles per attempt, capped at 1h', () => {
    expect(
      backoffMs({ maxAttempts: 5, backoff: 'exponential', delayMs: 1000 }, 1),
    ).toBe(1000);
    expect(
      backoffMs({ maxAttempts: 5, backoff: 'exponential', delayMs: 1000 }, 3),
    ).toBe(4000);
    expect(
      backoffMs(
        { maxAttempts: 5, backoff: 'exponential', delayMs: 3_600_000 },
        4,
      ),
    ).toBe(3_600_000);
  });
});

describe('realSleeper', () => {
  it('resolves after the given delay', async () => {
    await expect(realSleeper.sleep(0)).resolves.toBeUndefined();
  });
});
