jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { AccessGrantsService } from './access-grants.service';
import { ActorService } from '../common/actor.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';

/**
 * The AccessGrant → workflow TRANSACTIONAL OUTBOX (ADR-0054 §1, the INV-5 inverse). Exercises the REAL
 * WorkflowTriggerService (its `planForTrigger` / `buildRunData` / `enqueue`) wired to a mock Prisma +
 * mock BullMQ queue, plus the AccessGrantsService grant/revoke/batch paths. Proves: (1) a PENDING run is
 * written ATOMICALLY in the grant tx keyed by the unique idempotencyKey, (2) a failing enqueue / lookup
 * NEVER rolls back or blocks the grant, (3) LAST_ACTIVE_GRANT only deprovisions on the last active grant.
 */

const APP = 'app_cuid_1';
const USER = '22222222-2222-2222-2222-222222222222';

function plan(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wf1',
    enabled: true,
    deletedAt: null,
    executedAsServiceAccountId: 'sa_engine',
    deprovisionPolicy: 'LAST_ACTIVE_GRANT',
    versions: [{ id: 5 }],
    ...overrides,
  };
}

function build() {
  const accessGrant = {
    create: jest.fn(),
    update: jest.fn(),
    findUnique: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  };
  const workflowRun = { create: jest.fn().mockResolvedValue({ id: 'run1' }) };
  const applicationWorkflow = { findFirst: jest.fn().mockResolvedValue(null) };
  const user = {
    findFirst: jest.fn((a: { where: { id: string } }) =>
      Promise.resolve({ id: a.where.id }),
    ),
  };
  const application = { findFirst: jest.fn().mockResolvedValue({ id: APP }) };
  const tx = { accessGrant, workflowRun };
  const prisma = {
    accessGrant,
    workflowRun,
    applicationWorkflow,
    user,
    application,
    $transaction: jest.fn(
      (arg: Array<Promise<unknown>> | ((t: unknown) => unknown)) =>
        Array.isArray(arg) ? Promise.all(arg) : arg(tx),
    ),
  };
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job1' }) };
  const trigger = new WorkflowTriggerService(prisma as never, queue as never);
  const service = new AccessGrantsService(
    prisma as never,
    new ActorService(),
    trigger,
  );
  return {
    service,
    prisma,
    accessGrant,
    workflowRun,
    applicationWorkflow,
    queue,
  };
}

describe('AccessGrant outbox — create', () => {
  it('writes a PENDING run keyed by the unique idempotencyKey, then enqueues a start job', async () => {
    const h = build();
    h.applicationWorkflow.findFirst.mockResolvedValue(plan());
    h.accessGrant.create.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });

    const grant = await h.service.create({ userId: USER, applicationId: APP });

    expect(grant).toMatchObject({ id: 'g1' });
    const runData = h.workflowRun.create.mock.calls[0][0].data;
    expect(runData.idempotencyKey).toBe('ACCESS_GRANTED:g1');
    expect(runData.status).toBe('PENDING');
    expect(runData.workflowVersionId).toBe(5);
    expect(runData.executedAsServiceAccountId).toBe('sa_engine');
    // Enqueued AFTER commit with a deterministic start jobId (idempotent).
    expect(h.queue.add).toHaveBeenCalledWith(
      'run-start',
      { runId: 'run1' },
      expect.objectContaining({ jobId: 'start:run1' }),
    );
  });

  it('DECOUPLING: a failing enqueue does NOT throw and the grant is still returned (run stays PENDING)', async () => {
    const h = build();
    h.applicationWorkflow.findFirst.mockResolvedValue(plan());
    h.accessGrant.create.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.queue.add.mockRejectedValue(
      Object.assign(new Error('connect ECONNREFUSED'), {
        code: 'ECONNREFUSED',
      }),
    );

    const grant = await h.service.create({ userId: USER, applicationId: APP });

    expect(grant).toMatchObject({ id: 'g1' });
    // The run row was still committed in the tx — the sweeper will re-enqueue it.
    expect(h.workflowRun.create).toHaveBeenCalledTimes(1);
  });

  it('DECOUPLING: a failing workflow LOOKUP is swallowed — the grant proceeds with no run', async () => {
    const h = build();
    h.applicationWorkflow.findFirst.mockRejectedValue(new Error('db blip'));
    h.accessGrant.create.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });

    const grant = await h.service.create({ userId: USER, applicationId: APP });

    expect(grant).toMatchObject({ id: 'g1' });
    expect(h.workflowRun.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });

  it('no enabled workflow → behaves exactly as today (no run row, no enqueue)', async () => {
    const h = build();
    h.applicationWorkflow.findFirst.mockResolvedValue(null);
    h.accessGrant.create.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });

    await h.service.create({ userId: USER, applicationId: APP });

    expect(h.workflowRun.create).not.toHaveBeenCalled();
    expect(h.queue.add).not.toHaveBeenCalled();
  });
});

describe('AccessGrant outbox — revoke (LAST_ACTIVE_GRANT)', () => {
  const grantRow = {
    id: 'g1',
    revokedAt: null,
    userId: USER,
    applicationId: APP,
  };

  it('does NOT fire when the user still holds another active grant on the app', async () => {
    const h = build();
    h.accessGrant.findUnique.mockResolvedValue(grantRow);
    h.applicationWorkflow.findFirst.mockResolvedValue(plan()); // LAST_ACTIVE_GRANT
    h.accessGrant.update.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.accessGrant.count.mockResolvedValue(1); // one OTHER active grant remains

    await h.service.revoke('g1', {});

    expect(h.workflowRun.create).not.toHaveBeenCalled();
  });

  it('FIRES when the revoked grant was the last active grant (count 0)', async () => {
    const h = build();
    h.accessGrant.findUnique.mockResolvedValue(grantRow);
    h.applicationWorkflow.findFirst.mockResolvedValue(plan());
    h.accessGrant.update.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.accessGrant.count.mockResolvedValue(0); // none remaining → this was the last

    await h.service.revoke('g1', {});

    const runData = h.workflowRun.create.mock.calls[0][0].data;
    expect(runData.idempotencyKey).toBe('ACCESS_REVOKED:g1');
    expect(h.queue.add).toHaveBeenCalled();
  });

  it('EACH_GRANT policy fires on every revoke regardless of remaining grants', async () => {
    const h = build();
    h.accessGrant.findUnique.mockResolvedValue(grantRow);
    h.applicationWorkflow.findFirst.mockResolvedValue(
      plan({ deprovisionPolicy: 'EACH_GRANT' }),
    );
    h.accessGrant.update.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.accessGrant.count.mockResolvedValue(3); // ignored under EACH_GRANT

    await h.service.revoke('g1', {});

    expect(h.workflowRun.create).toHaveBeenCalledTimes(1);
    expect(h.accessGrant.count).not.toHaveBeenCalled();
  });
});
