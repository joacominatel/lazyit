jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { WorkflowRunSweeper } from './workflow-run.sweeper';

const CONN = 'cjld2cjxh0000qzrmn831i7rn';
/** A MANUAL step (m1) → REST step (s1): m1's onSuccess edge is the NEXT step, s1. */
const STEPS = [
  {
    kind: 'MANUAL',
    key: 'm1',
    prompt: 'Pick a team',
    inputFields: [{ name: 'team', label: 'Team', type: 'text' }],
  },
  { kind: 'REST', key: 's1', connectionId: CONN, method: 'POST', path: '/s1' },
];

const LONG_AGO = new Date(0);

function build() {
  const prisma = {
    workflowRun: {
      findMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const trigger = {
    enqueue: jest.fn().mockResolvedValue(true),
    enqueueResume: jest.fn().mockResolvedValue(true),
    inFlightRunIds: jest.fn(),
  };
  const sweeper = new WorkflowRunSweeper(prisma as never, trigger as never);
  return { sweeper, prisma, trigger };
}

describe('WorkflowRunSweeper — AWAITING_INPUT reconciler (CCOR-2)', () => {
  it('re-enqueues a LOST resume: a run AWAITING_INPUT whose latest task is COMPLETED + stale', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run1',
        workflowVersion: { steps: STEPS },
        manualTasks: [
          { id: 't1', stepKey: 'm1', status: 'COMPLETED', updatedAt: LONG_AGO },
        ],
      },
    ]);

    const n = await sweeper.reconcileAwaitingInput();

    expect(n).toBe(1);
    // Re-derived cursor = m1's onSuccess = the next step s1; rotating non-colliding jobId so a stale
    // completed `resume:run1:s1` job can't dedupe the recovery away.
    expect(trigger.enqueueResume).toHaveBeenCalledWith('run1', 's1', {
      jobId: 'resume:run1:s1:reconcile:t1',
    });
  });

  it('re-derives a CANCELLED task down the failure edge (STOP_FAIL for an escalated non-MANUAL step)', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run2',
        workflowVersion: { steps: STEPS },
        // The latest task is on the REST step s1 (an ESCALATED_FAILURE) and was CANCELLED → STOP_FAIL.
        manualTasks: [
          { id: 't2', stepKey: 's1', status: 'CANCELLED', updatedAt: LONG_AGO },
        ],
      },
    ]);

    const n = await sweeper.reconcileAwaitingInput();

    expect(n).toBe(1);
    expect(trigger.enqueueResume).toHaveBeenCalledWith('run2', 'STOP_FAIL', {
      jobId: 'resume:run2:STOP_FAIL:reconcile:t2',
    });
  });

  it('leaves a run whose latest task is still PENDING (genuinely awaiting a human)', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run3',
        workflowVersion: { steps: STEPS },
        manualTasks: [
          { id: 't3', stepKey: 'm1', status: 'PENDING', updatedAt: LONG_AGO },
        ],
      },
    ]);

    const n = await sweeper.reconcileAwaitingInput();

    expect(n).toBe(0);
    expect(trigger.enqueueResume).not.toHaveBeenCalled();
  });

  it('gives a JUST-resolved task a chance (does not race the live resume)', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([
      {
        id: 'run4',
        workflowVersion: { steps: STEPS },
        manualTasks: [
          {
            id: 't4',
            stepKey: 'm1',
            status: 'COMPLETED',
            updatedAt: new Date(),
          },
        ],
      },
    ]);

    const n = await sweeper.reconcileAwaitingInput();

    expect(n).toBe(0);
    expect(trigger.enqueueResume).not.toHaveBeenCalled();
  });
});

describe('WorkflowRunSweeper — RUNNING-staleness reconciler (CCOR-4)', () => {
  it('finalizes a stranded RUNNING run (no in-flight job) FAILED with the engine-restart class', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([
      { id: 'runX' },
      { id: 'runY' },
    ]);
    // runY has a delayed/active job (it's backing off or in-flight) → protected; runX is stranded.
    trigger.inFlightRunIds.mockResolvedValue(new Set(['runY']));

    const n = await sweeper.reconcileRunningStale();

    expect(n).toBe(1);
    expect(prisma.workflowRun.updateMany).toHaveBeenCalledTimes(1);
    // Guarded finalize: only the stranded run, only while still RUNNING, with the engine-restart class.
    const updateMany = prisma.workflowRun.updateMany as jest.Mock<
      Promise<{ count: number }>,
      [
        {
          where: Record<string, unknown>;
          data: { status: string; error: { errorClass: string } };
        },
      ]
    >;
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: 'runX', status: 'RUNNING' });
    expect(call.data).toMatchObject({ status: 'FAILED' });
    expect(call.data.error.errorClass).toBe('engine-restart');
  });

  it('SKIPS the whole pass when broker state is unknown (never fails a possibly-backing-off run)', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([{ id: 'runX' }]);
    trigger.inFlightRunIds.mockResolvedValue(null);

    const n = await sweeper.reconcileRunningStale();

    expect(n).toBe(0);
    expect(prisma.workflowRun.updateMany).not.toHaveBeenCalled();
  });

  it('does not query the broker when there are no stale RUNNING runs', async () => {
    const { sweeper, prisma, trigger } = build();
    prisma.workflowRun.findMany.mockResolvedValue([]);

    const n = await sweeper.reconcileRunningStale();

    expect(n).toBe(0);
    expect(trigger.inFlightRunIds).not.toHaveBeenCalled();
  });
});
