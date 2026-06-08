jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: Symbol('DbNull') },
}));

import { ForbiddenException } from '@nestjs/common';
import { ManualTasksService } from './manual-tasks.service';
import { ActorService } from '../../common/actor.service';

const CONN = 'cjld2cjxh0000qzrmn831i7rn';
const STEPS = [
  {
    kind: 'MANUAL',
    key: 'm1',
    prompt: 'Pick a team',
    inputFields: [{ name: 'team', label: 'Team', type: 'text' }],
  },
  {
    kind: 'REST',
    key: 's1',
    connectionId: CONN,
    method: 'POST',
    path: '/s1',
    onFailure: 'ESCALATE_TO_MANUAL',
  },
];

const human = (id: string) => ({ kind: 'human', user: { id } }) as never;

function build(taskOver: Record<string, unknown> = {}) {
  const task = {
    id: 't1',
    runId: 'run1',
    stepKey: 'm1',
    assigneeId: null,
    cohort: null,
    prompt: 'Pick a team',
    status: 'PENDING',
    input: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    run: { workflowVersion: { steps: STEPS } },
    ...taskOver,
  };
  const manualTask = {
    findFirst: jest.fn().mockResolvedValue(task),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const prisma = { manualTask };
  const trigger = { enqueueResume: jest.fn().mockResolvedValue(true) };
  const service = new ManualTasksService(
    prisma as never,
    new ActorService(),
    trigger as never,
  );
  return { service, manualTask, trigger, task };
}

describe('ManualTasksService — IDOR guard', () => {
  it('rejects a non-assignee resolving an ASSIGNED task (403) and never completes it', async () => {
    const h = build({ assigneeId: 'userA' });
    await expect(
      h.service.submit('t1', { input: {} }, human('userB')),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.manualTask.updateMany).not.toHaveBeenCalled();
    expect(h.trigger.enqueueResume).not.toHaveBeenCalled();
  });

  it('lets the assignee resolve their task', async () => {
    const h = build({ assigneeId: 'userA' });
    await h.service.submit(
      't1',
      { input: { team: 'Platform' } },
      human('userA'),
    );
    expect(h.manualTask.updateMany).toHaveBeenCalledTimes(1);
  });

  it('lets any permission-holder resolve an UNASSIGNED (cohort) task', async () => {
    const h = build({ assigneeId: null });
    await h.service.submit(
      't1',
      { input: { team: 'Platform' } },
      human('anyone'),
    );
    expect(h.manualTask.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('ManualTasksService — resume cursors (re-enter the DAG)', () => {
  it('submit on a MANUAL step resumes at its onSuccess (the next step)', async () => {
    const h = build({ stepKey: 'm1' });
    const res = await h.service.submit('t1', { input: { team: 'Platform' } });
    expect(res.resumeCursor).toBe('s1');
    expect(h.trigger.enqueueResume).toHaveBeenCalledWith('run1', 's1');
    // The cleaned input is recorded COMPLETED for the resume context.
    const data = h.manualTask.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('COMPLETED');
    expect(data.input).toEqual({ team: 'Platform' });
  });

  it('fail on a MANUAL step resumes down its onFailure (STOP_FAIL by default)', async () => {
    const h = build({ stepKey: 'm1' });
    const res = await h.service.fail('t1');
    expect(res.resumeCursor).toBe('STOP_FAIL');
    const data = h.manualTask.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('CANCELLED');
  });

  it('fail on an ESCALATED_FAILURE task stops the run (STOP_FAIL)', async () => {
    const h = build({ stepKey: 's1' });
    const res = await h.service.fail('t1');
    expect(res.resumeCursor).toBe('STOP_FAIL');
  });

  it('submit on an ESCALATED_FAILURE task continues at the failed step onSuccess', async () => {
    const h = build({ stepKey: 's1' });
    // s1 is the last step → its onSuccess is END_SUCCESS.
    const res = await h.service.submit('t1', { input: {} });
    expect(res.resumeCursor).toBe('END_SUCCESS');
  });
});

describe('ManualTasksService — findOne origin derivation', () => {
  it('derives MANUAL_STEP + the step input form for a manual step task', async () => {
    const h = build({ stepKey: 'm1' });
    const dto = await h.service.findOne('t1');
    expect(dto.origin).toBe('MANUAL_STEP');
    // WorkflowStepsSchema.parse applies the `required` default (false).
    expect(dto.inputFields).toEqual([
      { name: 'team', label: 'Team', type: 'text', required: false },
    ]);
  });

  it('derives ESCALATED_FAILURE + a synthetic resolution-note form for a failed step task', async () => {
    const h = build({ stepKey: 's1' });
    const dto = await h.service.findOne('t1');
    expect(dto.origin).toBe('ESCALATED_FAILURE');
    expect(dto.inputFields).toEqual([
      {
        name: 'resolutionNote',
        label: 'Resolution note',
        type: 'text',
        required: false,
      },
    ]);
  });
});
