jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import {
  assertReplaySafe,
  realSleeper,
  ReplayNotIdempotentError,
  resolveFailedStepKey,
  RetryNotResolvableError,
  WorkflowRunOrchestrator,
  backoffMs,
  type Sleeper,
} from './workflow-run.orchestrator';
import type { WorkflowStep } from '@lazyit/shared';
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
  // A connector mock map. `scripted()` returns a zero-arg execute; some tests use a custom mock whose
  // execute reads the rendered { step } (e.g. to prove an override reached the mapping), so the execute
  // signature is left loose here — the registry is cast to `never` below anyway.
  handlers: Record<string, { kind: string; execute: jest.Mock }>,
) {
  const state = {
    runStatus: 'PENDING' as string,
    // The redacted failure summary on the run (set by finalizeFailed) — the manual retry (#308) resumes
    // from `error.stepKey`. Tests preset it to drive the resume cursor.
    runError: null as Record<string, unknown> | null,
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
          data: { status: string; error?: unknown };
        }) => {
          if (where.status === state.runStatus) {
            state.runStatus = data.status;
            // A successful CAS that clears the failure summary (the manual retry, #308) drops runError.
            if ('error' in data) {
              state.runError = null;
            }
            return { count: 1 };
          }
          return { count: 0 };
        },
      ),
      findFirst: jest.fn(async () => ({
        id: 'run1',
        status: state.runStatus,
        trigger: 'ACCESS_GRANTED',
        error: state.runError,
        workflowVersion: { steps },
      })),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.runUpdates.push(data);
        if (typeof data.status === 'string') {
          state.runStatus = data.status;
        }
        // finalizeFailed stamps the redacted { stepKey, errorClass } summary onto the run — track it so
        // the manual retry (#308) can resolve its resume cursor off it.
        if ('error' in data) {
          state.runError = data.error as Record<string, unknown> | null;
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
      findFirst: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: { runId: string; stepKey: string; attempt?: number };
          orderBy?: { attempt?: 'asc' | 'desc' };
        }) => {
          const matches = state.stepRuns.filter(
            (s) =>
              s.runId === where.runId &&
              s.stepKey === where.stepKey &&
              (where.attempt === undefined || s.attempt === where.attempt),
          );
          // The retryStep idempotency check passes an exact attempt (first match); nextAttemptFor passes
          // orderBy attempt:desc to find the max recorded attempt for the step.
          if (orderBy?.attempt === 'desc') {
            return (
              matches.sort(
                (a, b) => (b.attempt as number) - (a.attempt as number),
              )[0] ?? null
            );
          }
          return matches[0] ?? null;
        },
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

  // A transactional pause (CCOR-2) runs task + step-run + status-flip in one tx; the mock executes the
  // callback against the same in-memory prisma so the three writes are observed atomically.
  (prisma as unknown as { $transaction: unknown }).$transaction = jest.fn(
    async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: typeof prisma) => Promise<unknown>)(prisma)
        : Promise.all(arg as Promise<unknown>[]),
  );

  // The trigger seam: enqueueRetry schedules the OFF-worker backoff (CCOR-3). Default true (the slot is
  // freed); a test can make it resolve false to exercise the degraded in-process fallback.
  const trigger = {
    enqueueRetry: jest.fn().mockResolvedValue(true),
    enqueueResume: jest.fn().mockResolvedValue(true),
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
  // The orchestrator fires a best-effort post-commit `workflow.manual_task` bell nudge when a run
  // pauses; these tests assert on the run/step state, not the bell, so a no-op mock keeps them
  // unchanged (the emit swallows its own errors anyway).
  const notifications = { emit: jest.fn().mockResolvedValue(null) };

  const orchestrator = new WorkflowRunOrchestrator(
    prisma as never,
    registry as never,
    secrets as never,
    contextBuilder as never,
    sleeper,
    trigger as never,
    notifications as never,
  );
  return { orchestrator, prisma, state, sleeper, trigger };
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

  it('CCOR-3 off-worker backoff: a transient failure schedules a DELAYED retry and frees the slot (no in-process sleep)', async () => {
    const { orchestrator, state, sleeper, trigger } = harness(
      [
        restStep('s1', {
          retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 1000 },
        }),
      ],
      { REST: scripted('REST', [failTransient(503), ok()]) },
    );

    await orchestrator.start('run1');

    // The walk RETURNED to the broker mid-step: the run stays RUNNING (not slept-on), one FAILED attempt
    // row is recorded, and the next attempt is a delayed re-enqueue — the worker slot is free.
    expect(state.runStatus).toBe('RUNNING');
    expect(state.stepRuns).toHaveLength(1);
    expect(state.stepRuns[0]).toMatchObject({ attempt: 1, status: 'FAILED' });
    expect(state.stepRuns[0].metadata).toMatchObject({ retriedAfterMs: 1000 });
    expect(sleeper.sleep).not.toHaveBeenCalled();
    expect(trigger.enqueueRetry).toHaveBeenCalledWith('run1', 's1', 2, 1000);

    // The delayed retry re-enters at the same step's attempt 2 and finishes the run.
    await orchestrator.retryStep('run1', 's1', 2);
    expect(state.runStatus).toBe('SUCCEEDED');
    expect(state.stepRuns).toHaveLength(2);
    expect(state.stepRuns[1]).toMatchObject({
      attempt: 2,
      status: 'SUCCEEDED',
    });
  });

  it('CCOR-3 retryStep is idempotent: a re-delivered attempt that already ran is a no-op', async () => {
    const rest = scripted('REST', [ok()]);
    const { orchestrator, state } = harness(
      [
        restStep('s1', {
          retry: { maxAttempts: 3, backoff: 'fixed', delayMs: 1 },
        }),
      ],
      { REST: rest },
    );
    // Pretend attempt 2 already produced its append-only row (the first delivery ran it).
    state.runStatus = 'RUNNING';
    state.stepRuns.push({
      runId: 'run1',
      stepKey: 's1',
      attempt: 2,
      status: 'FAILED',
    });

    await orchestrator.retryStep('run1', 's1', 2);

    expect(rest.execute).not.toHaveBeenCalled();
    expect(state.stepRuns).toHaveLength(1);
  });

  it('CCOR-3 degraded fallback: a broker-down retry backs off IN-PROCESS capped well under the lock, then continues', async () => {
    const { orchestrator, state, sleeper, trigger } = harness(
      [
        restStep('s1', {
          // A 1h base backoff: the in-process fallback must CAP it (MAX_INPROCESS_BACKOFF_MS = 2000ms).
          retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 3_600_000 },
        }),
      ],
      { REST: scripted('REST', [failTransient(503), ok()]) },
    );
    trigger.enqueueRetry.mockResolvedValue(false); // broker unavailable → no off-worker re-enqueue

    await orchestrator.start('run1');

    expect(state.runStatus).toBe('SUCCEEDED');
    expect(state.stepRuns).toHaveLength(2);
    // The in-process sleep is CAPPED at MAX_INPROCESS_BACKOFF_MS, never the full 1h.
    expect(sleeper.sleep).toHaveBeenCalledTimes(1);
    expect(sleeper.sleep).toHaveBeenCalledWith(2000);
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

  it('CCOR-2 pause is transactional: a MANUAL pause flips AWAITING_INPUT atomically with the resolvable task (TOCTOU-safe)', async () => {
    const steps = [
      {
        kind: 'MANUAL',
        key: 'm1',
        prompt: 'Pick a team',
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
    const { orchestrator, prisma, state } = harness(steps, {
      MANUAL: manual,
      REST: scripted('REST', [ok()]),
    });

    await orchestrator.start('run1');

    // Task + the pausing step row + the AWAITING_INPUT flip commit in ONE tx — so the PENDING task is
    // never resolvable while the run is still RUNNING (which would let a completion no-op its own resume
    // and strand the run AWAITING_INPUT forever).
    expect(
      (prisma as unknown as { $transaction: jest.Mock }).$transaction,
    ).toHaveBeenCalledTimes(1);
    expect(state.runStatus).toBe('AWAITING_INPUT');
    expect(state.manualTasks).toHaveLength(1);
    const paused = state.stepRuns.find((s) => s.status === 'AWAITING_INPUT');
    expect((paused!.metadata as Record<string, unknown>).manualTaskId).toBe(
      'task1',
    );
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

  it('INV-6: a handler that THROWS persists a bounded reason, never the raw error (no IP/secret) — issue #352', async () => {
    // A handler should never throw (the defensive catch), but if it does, its raw message can carry an
    // internal IP or a secret. The orchestrator must drop it at the write boundary and persist only a
    // bounded literal into the append-only step-run ledger.
    const throwing = {
      kind: 'REST',
      execute: jest.fn(async () => {
        throw new Error(
          'connect ECONNREFUSED 10.0.0.5:443 token=ghp_secretzzz',
        );
      }),
    };
    const { orchestrator, state } = harness([restStep('s1')], {
      REST: throwing,
    });

    await orchestrator.start('run1');

    const failed = state.stepRuns.find((s) => s.status === 'FAILED');
    expect(failed).toBeDefined();
    expect((failed!.metadata as Record<string, unknown>).errorClass).toBe(
      'handler-threw',
    );
    // Assert against the SERIALIZED persisted metadata: nothing from the raw message may survive.
    const persisted = JSON.stringify(failed!.metadata);
    expect(persisted).not.toContain('10.0.0.5');
    expect(persisted).not.toContain('ghp_secretzzz');
    expect(persisted).not.toContain('ECONNREFUSED');
  });
});

describe('WorkflowRunOrchestrator.retryRun — manual FAILED-run retry (issue #308)', () => {
  /** A two-step linear flow: s1 (a non-idempotent create) → s2. s2 is the one that failed. */
  const TWO_STEP = [restStep('s1'), restStep('s2')];

  /** Seed a harness whose run is already FAILED at `failedStepKey`, with s1 already SUCCEEDED once. */
  function failedAtS2() {
    // s2 fails permanently on its FIRST execution; on the RETRY re-entry it succeeds.
    const rest = scripted('REST', [ok(), failPermanent(500), ok()]);
    const h = harness(TWO_STEP, { REST: rest });
    return { ...h, rest };
  }

  it('CAS guard: only a FAILED run flips to RUNNING — a non-FAILED run never re-enqueues', async () => {
    for (const status of [
      'PENDING',
      'RUNNING',
      'AWAITING_INPUT',
      'SUCCEEDED',
      'COMPENSATED',
    ]) {
      const { orchestrator, state, trigger } = harness(TWO_STEP, {
        REST: scripted('REST', [ok()]),
      });
      state.runStatus = status;
      state.runError = { stepKey: 's2', errorClass: 'step-failed' };

      const result = await orchestrator.retryRun('run1');

      expect(result).toEqual({ retried: false });
      // The run is untouched and NOTHING is enqueued — only FAILED is retryable.
      expect(state.runStatus).toBe(status);
      expect(trigger.enqueueRetry).not.toHaveBeenCalled();
    }
  });

  it('CAS guard: a FAILED run flips FAILED→RUNNING (clearing the error) and enqueues the retry', async () => {
    const { orchestrator, state, trigger } = harness(TWO_STEP, {
      REST: scripted('REST', [ok()]),
    });
    state.runStatus = 'FAILED';
    state.runError = { stepKey: 's2', errorClass: 'step-failed' };

    const result = await orchestrator.retryRun('run1');

    expect(result).toEqual({ retried: true, resumeStepKey: 's2', attempt: 1 });
    expect(state.runStatus).toBe('RUNNING');
    expect(state.runError).toBeNull();
    // The retry is re-enqueued at the FAILED step with delay 0 (off-request, decoupled posture).
    expect(trigger.enqueueRetry).toHaveBeenCalledWith('run1', 's2', 1, 0);
  });

  it('resume-from-failed-step: a SUCCEEDED non-idempotent step is NOT re-executed (no double-provision)', async () => {
    const { orchestrator, state, rest, trigger } = failedAtS2();

    // 1) The run executes: s1 SUCCEEDS (a non-idempotent create), s2 FAILS → run FAILED.
    await orchestrator.start('run1');
    expect(state.runStatus).toBe('FAILED');
    const s1Successes = () =>
      state.stepRuns.filter(
        (s) => s.stepKey === 's1' && s.status === 'SUCCEEDED',
      );
    expect(s1Successes()).toHaveLength(1);
    expect(rest.execute).toHaveBeenCalledTimes(2); // s1 + s2 (once each)

    // 2) Retry — the CAS flips FAILED→RUNNING, then the worker picks up the enqueued retry job.
    const result = await orchestrator.retryRun('run1');
    expect(result).toMatchObject({ retried: true, resumeStepKey: 's2' });
    const [, stepKey, attempt] = trigger.enqueueRetry.mock.calls[0];
    await orchestrator.retryStep('run1', stepKey, attempt);

    // The run now SUCCEEDS — and s1 (the non-idempotent create) was NEVER run a second time.
    expect(state.runStatus).toBe('SUCCEEDED');
    expect(s1Successes()).toHaveLength(1);
    // Only s2 was re-executed on retry: s1 once, s2 twice (the original fail + the successful retry).
    expect(rest.execute).toHaveBeenCalledTimes(3);
    const s2Rows = state.stepRuns.filter((s) => s.stepKey === 's2');
    expect(s2Rows.map((s) => s.status)).toEqual(['FAILED', 'SUCCEEDED']);
  });

  it('append-only attempts: the retried failed step re-runs as attempt+1, never colliding', async () => {
    const { orchestrator, state, trigger } = failedAtS2();
    await orchestrator.start('run1'); // s2 fails at attempt 1

    await orchestrator.retryRun('run1');
    const [, stepKey, attempt] = trigger.enqueueRetry.mock.calls[0];
    expect(attempt).toBe(2); // max prior s2 attempt (1) + 1
    await orchestrator.retryStep('run1', stepKey, attempt);

    const s2Rows = state.stepRuns.filter((s) => s.stepKey === 's2');
    expect(s2Rows.map((s) => s.attempt)).toEqual([1, 2]);
  });

  it('INV-6: a retry OVERRIDE patches the next attempt in-memory and is NEVER persisted to the ledger/run/log', async () => {
    // s2 carries a data mapping; it fails first, then succeeds on the override-patched retry. The handler
    // records only the mapped field NAMES (INV-6) — the test proves the operator-typed VALUE never lands
    // in any WorkflowStepRun.metadata / WorkflowRun.error / run update.
    const SECRET = 'Doe-PII-7c3f-secret';
    const rest = {
      kind: 'REST',
      // Capture the step the handler renders so we can prove the override reached the mapping in-memory.
      execute: jest.fn(
        (() => {
          let i = 0;
          return async ({ step }: { step: { dataMapping?: unknown } }) => {
            const seq: StepResult[] = [
              ok(),
              failPermanent(500),
              // On the retry, record only the mapped field NAMES (never their values), as the real
              // handler does — this is the redacted metadata the orchestrator persists.
              {
                status: 'SUCCEEDED',
                externalCorrelationId: 'ext-1',
                metadata: {
                  statusCode: 200,
                  mappedFields: Object.keys(
                    (step.dataMapping as Record<string, string>) ?? {},
                  ),
                },
              },
            ];
            const r = seq[Math.min(i, seq.length - 1)];
            i += 1;
            return r;
          };
        })(),
      ),
    };
    const steps = [
      restStep('s1'),
      restStep('s2', { dataMapping: { email: '{{ grantee.email }}' } }),
    ];
    const { orchestrator, state, trigger } = harness(steps, { REST: rest });

    await orchestrator.start('run1'); // s1 ok, s2 fails → run FAILED at s2
    expect(state.runStatus).toBe('FAILED');

    // Retry WITH an operator override carrying a PII value for a NEW field.
    await orchestrator.retryRun('run1', { lastName: SECRET });
    const [, stepKey, attempt] = trigger.enqueueRetry.mock.calls[0];
    await orchestrator.retryStep('run1', stepKey, attempt);
    expect(state.runStatus).toBe('SUCCEEDED');

    // 1) The override REACHED the in-memory render: the handler saw the merged mapping (field present).
    const lastCall = rest.execute.mock.calls.at(-1)?.[0] as {
      step: { dataMapping?: Record<string, string> };
    };
    expect(lastCall.step.dataMapping).toMatchObject({ lastName: SECRET });

    // 2) The VALUE is NOWHERE persisted — not in any step-run row, not in the run error / updates.
    const persisted = JSON.stringify({
      stepRuns: state.stepRuns,
      runUpdates: state.runUpdates,
      runError: state.runError,
    });
    expect(persisted).not.toContain(SECRET);

    // 3) Only the field NAME is recorded (the redacted mappedFields), exactly as today.
    const s2Success = state.stepRuns.find(
      (s) => s.stepKey === 's2' && s.status === 'SUCCEEDED',
    ) as { metadata: { mappedFields?: string[] } };
    expect(s2Success.metadata.mappedFields).toContain('lastName');

    // 4) The transient override is single-use: nothing lingers for a later attempt.
    const persistedAgain = JSON.stringify(state.stepRuns);
    expect(persistedAgain).not.toContain(SECRET);
  });

  it('AUTOMATIC per-attempt retry (retryStep) replays the PINNED version with NO override applied', async () => {
    // The engine's own transient retry must stay deterministic: even after a manual retryRun stashed an
    // override, the AUTOMATIC retryStep path never reads it — it re-renders the pinned mapping verbatim.
    const rest = {
      kind: 'REST',
      execute: jest.fn(
        (() => {
          let i = 0;
          return async ({ step }: { step: { dataMapping?: unknown } }) => {
            const seq: StepResult[] = [ok(), failTransient(503), ok()];
            const r = seq[Math.min(i, seq.length - 1)];
            i += 1;
            // Record the mapping the handler saw so we can assert no override leaked into it.
            return {
              ...r,
              metadata: {
                ...r.metadata,
                seenFields: Object.keys(
                  (step.dataMapping as Record<string, string>) ?? {},
                ),
              },
            };
          };
        })(),
      ),
    };
    const steps = [
      restStep('s1'),
      restStep('s2', {
        dataMapping: { email: '{{ grantee.email }}' },
        retry: { maxAttempts: 2, backoff: 'fixed', delayMs: 0 },
      }),
    ];
    const { orchestrator, state, trigger } = harness(steps, { REST: rest });

    await orchestrator.start('run1'); // s1 ok; s2 transient-fails attempt 1 → schedules retryStep
    const [, stepKey, attempt] = trigger.enqueueRetry.mock.calls[0];
    expect(stepKey).toBe('s2');
    // Drive the AUTOMATIC per-attempt retry — it must NOT carry any override (none was set anyway, and
    // even if one were, retryStep never consults pendingOverrides).
    await orchestrator.retryStep('run1', stepKey, attempt);
    expect(state.runStatus).toBe('SUCCEEDED');

    // s2 (the retried step) only ever saw its PINNED mapping (`email`) — never an injected override field.
    const s2Calls = rest.execute.mock.calls.filter(
      (c) =>
        (c[0] as { step: { key: string } }).step.key === 's2',
    );
    expect(s2Calls.length).toBeGreaterThanOrEqual(2); // attempt 1 (fail) + the automatic retry
    for (const call of s2Calls) {
      const seen = (call[0] as { step: { dataMapping?: Record<string, string> } })
        .step.dataMapping;
      expect(Object.keys(seen ?? {})).toEqual(['email']);
    }
  });

  it('422 (RetryNotResolvableError): a FAILED run with no resolvable failed step is not retryable', async () => {
    const { orchestrator, state } = harness(TWO_STEP, {
      REST: scripted('REST', [ok()]),
    });
    state.runStatus = 'FAILED';
    // The error names a step that is NOT in the pinned version (or is absent) — nowhere to resume from.
    state.runError = { stepKey: 'ghost', errorClass: 'engine-error' };

    await expect(orchestrator.retryRun('run1')).rejects.toBeInstanceOf(
      RetryNotResolvableError,
    );
    // The run is left FAILED — never half-flipped to RUNNING with nowhere to go.
    expect(state.runStatus).toBe('FAILED');
  });
});

describe('resolveFailedStepKey', () => {
  // resolveFailedStepKey only inspects each step's `key`, so a minimal fixture suffices (cast via
  // unknown since the partial shape does not structurally satisfy the full discriminated WorkflowStep).
  const steps = [
    { key: 's1' },
    { key: 's2' },
  ] as unknown as ReadonlyArray<WorkflowStep>;
  it('returns the error.stepKey when it names a real step in the pinned version', () => {
    expect(
      resolveFailedStepKey({ stepKey: 's2', errorClass: 'step-failed' }, steps),
    ).toBe('s2');
  });
  it('returns null for a missing / non-string / unknown step key (not resumable)', () => {
    expect(resolveFailedStepKey(null, steps)).toBeNull();
    expect(resolveFailedStepKey({}, steps)).toBeNull();
    expect(resolveFailedStepKey({ stepKey: 42 }, steps)).toBeNull();
    expect(resolveFailedStepKey({ stepKey: 'ghost' }, steps)).toBeNull();
  });
});

describe('assertReplaySafe — the FAIL-CLOSED double-provision guard (ADR-0057 Decision 3)', () => {
  // A minimal but valid step fixture: REST steps carry an `idempotent` flag; MANUAL has no side effect.
  const steps = [
    restStep('create', { idempotent: false }),
    restStep('notify', { idempotent: true }),
    restStep('finalize', { idempotent: false }),
  ] as unknown as ReadonlyArray<WorkflowStep>;

  it('REFUSES when a non-idempotent create already SUCCEEDED on/before the failed step', () => {
    // `create` (idempotent:false) succeeded, the run failed at `finalize` — re-firing would re-create.
    expect(() =>
      assertReplaySafe(steps, 'finalize', [{ stepKey: 'create' }]),
    ).toThrow(ReplayNotIdempotentError);
  });

  it('REFUSES even when the failed step IS the non-idempotent create that succeeded on a later attempt-line', () => {
    // The guard is on/before the failed step INCLUSIVE: a non-idempotent create that succeeded at the
    // failed-step index itself still means re-firing double-provisions.
    expect(() =>
      assertReplaySafe(steps, 'create', [{ stepKey: 'create' }]),
    ).toThrow(ReplayNotIdempotentError);
  });

  it('ALLOWS when every completed provisioning step up to the failed step is idempotent', () => {
    // `notify` (idempotent:true) succeeded; the run failed at `finalize` before `finalize` ran. Safe.
    expect(() =>
      assertReplaySafe(steps, 'finalize', [{ stepKey: 'notify' }]),
    ).not.toThrow();
  });

  it('ALLOWS when the run failed at/before its first non-idempotent create (none succeeded yet)', () => {
    // The run failed at `create` itself with no SUCCEEDED provisioning rows — nothing to double-provision.
    expect(() => assertReplaySafe(steps, 'create', [])).not.toThrow();
  });

  it('ignores a SUCCEEDED step strictly AFTER the failed step (not a re-fire hazard for this clone)', () => {
    // Defensive: a real FAILED walk would not have a success after the failure, but the window is bounded.
    expect(() =>
      assertReplaySafe(steps, 'notify', [{ stepKey: 'finalize' }]),
    ).not.toThrow();
  });

  it('a MANUAL step is never a provisioning hazard (no external create to double)', () => {
    const withManual = [
      { kind: 'MANUAL', key: 'approve' },
      restStep('create', { idempotent: false }),
    ] as unknown as ReadonlyArray<WorkflowStep>;
    expect(() =>
      assertReplaySafe(withManual, 'create', [{ stepKey: 'approve' }]),
    ).not.toThrow();
  });

  it('fail-closed when the failed step is unresolvable: refuses if ANY non-idempotent create succeeded', () => {
    // No failed-step marker → the whole run is the window; a non-idempotent success anywhere refuses.
    expect(() =>
      assertReplaySafe(steps, null, [{ stepKey: 'finalize' }]),
    ).toThrow(ReplayNotIdempotentError);
  });

  // A WEBHOOK_OUT step is a provisioning kind too (signed outbound delivery) — it carries the same
  // `idempotent` flag and is gated identically (issue #355).
  const webhookStep = (key: string, idempotent: boolean) => ({
    kind: 'WEBHOOK_OUT',
    key,
    connectionId: CONN,
    idempotent,
  });

  it('REFUSES a non-idempotent WEBHOOK_OUT that already SUCCEEDED on/before the failed step', () => {
    const withWebhook = [
      webhookStep('deliver', false),
      restStep('finalize', { idempotent: false }),
    ] as unknown as ReadonlyArray<WorkflowStep>;
    expect(() =>
      assertReplaySafe(withWebhook, 'finalize', [{ stepKey: 'deliver' }]),
    ).toThrow(ReplayNotIdempotentError);
  });

  it('ALLOWS an idempotent WEBHOOK_OUT that SUCCEEDED on/before the failed step (replay-eligible)', () => {
    const withWebhook = [
      webhookStep('deliver', true),
      restStep('finalize', { idempotent: false }),
    ] as unknown as ReadonlyArray<WorkflowStep>;
    expect(() =>
      assertReplaySafe(withWebhook, 'finalize', [{ stepKey: 'deliver' }]),
    ).not.toThrow();
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
