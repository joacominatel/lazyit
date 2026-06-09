jest.mock('../../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { WorkflowTriggerService } from './workflow-trigger.service';
import { workflowJobId } from './workflow-run.constants';

/**
 * Regression guard for #298: every custom BullMQ jobId the engine produces MUST be colon-free. BullMQ
 * forbids `:` in a custom job id (its internal Redis key separator) — `queue.add` throws
 * `Custom Id cannot contain :` and the run never enqueues (stuck PENDING forever). The unit tests mock
 * `queue.add`, so before this guard the broken jobIds shipped: here we capture the jobId actually handed
 * to the mocked `queue.add` for the start / resume / retry paths and assert it carries no `:`.
 */
function build() {
  const add = jest.fn().mockResolvedValue({ id: 'job-1' });
  const queue = { add } as const;
  const prisma = {} as const;
  const service = new WorkflowTriggerService(prisma as never, queue as never);
  return { service, add };
}

/** The jobId option from the most recent `queue.add(name, data, opts)` call. */
function lastJobId(add: jest.Mock): unknown {
  const calls = add.mock.calls as Array<[string, unknown, { jobId?: unknown }]>;
  const lastCall = calls[calls.length - 1];
  return lastCall[2].jobId;
}

describe('WorkflowTriggerService — BullMQ-safe jobIds (#298)', () => {
  it('enqueue (start) passes a colon-free, non-empty jobId', async () => {
    const { service, add } = build();

    const ok = await service.enqueue('run-1');

    expect(ok).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);
    const jobId = lastJobId(add);
    expect(typeof jobId).toBe('string');
    expect(jobId).toBe('start-run-1');
    expect(jobId as string).not.toHaveLength(0);
    expect(jobId as string).not.toContain(':');
  });

  it('enqueueResume passes a colon-free jobId for the default (live) dedupe key', async () => {
    const { service, add } = build();

    const ok = await service.enqueueResume('run-1', 's1');

    expect(ok).toBe(true);
    const jobId = lastJobId(add);
    expect(jobId).toBe('resume-run-1-s1');
    expect(jobId as string).not.toContain(':');
  });

  it('enqueueResume strips a `:` a cursor itself might carry (defensive)', async () => {
    const { service, add } = build();

    await service.enqueueResume('run-1', 'STOP:FAIL');

    const jobId = lastJobId(add);
    expect(jobId).not.toContain(':');
    expect(jobId).toBe('resume-run-1-STOP-FAIL');
  });

  it('enqueueRetry passes a colon-free jobId keyed by run+step+attempt', async () => {
    const { service, add } = build();

    const ok = await service.enqueueRetry('run-1', 's1', 3, 1000);

    expect(ok).toBe(true);
    const jobId = lastJobId(add);
    expect(jobId).toBe('retry-run-1-s1-3');
    expect(jobId as string).not.toContain(':');
  });
});

describe('workflowJobId', () => {
  it('joins parts with `-`', () => {
    expect(workflowJobId('start', 'run-1')).toBe('start-run-1');
  });

  it('coerces numbers and joins them', () => {
    expect(workflowJobId('retry', 'run-1', 's1', 3)).toBe('retry-run-1-s1-3');
  });

  it('strips any `:` within a part (BullMQ forbids it)', () => {
    expect(workflowJobId('resume', 'run:1', 'a:b')).toBe('resume-run-1-a-b');
    expect(workflowJobId('x', 'a:b:c')).not.toContain(':');
  });

  it('produces a non-empty string', () => {
    expect(workflowJobId('start', 'run-1').length).toBeGreaterThan(0);
  });
});
