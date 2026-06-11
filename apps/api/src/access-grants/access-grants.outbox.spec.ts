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

/** The PENDING-run create call shape, so assertions on the outbox row stay type-safe (no-unsafe-*). */
type RunCreateCall = [
  {
    data: {
      idempotencyKey: string;
      status: string;
      workflowId: string;
      workflowVersionId: number;
      applicationId: string;
      accessGrantId: string;
      executedAsServiceAccountId?: string;
      replaySeq: number;
      supersedesRunId?: string | null;
    };
  },
];

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
  // The per-(userId, applicationId) advisory lock the LAST_ACTIVE_GRANT decision takes inside the tx
  // (CCOR-1). The mock just records the call; the real serialization semantics are proven in
  // access-grants.concurrency.spec.ts.
  const executeRaw = jest.fn().mockResolvedValue([]);
  const tx = { accessGrant, workflowRun, $executeRaw: executeRaw };
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
  // The post-commit notification emit is best-effort and swallows its own errors; these outbox tests
  // assert on the workflow run, not the bell, so a no-op mock keeps them unchanged.
  const notifications = { emit: jest.fn().mockResolvedValue(null) };
  const service = new AccessGrantsService(
    prisma as never,
    new ActorService(),
    trigger,
    notifications as never,
  );
  return {
    service,
    prisma,
    accessGrant,
    workflowRun,
    applicationWorkflow,
    queue,
    executeRaw,
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
    const runData = (h.workflowRun.create.mock.calls as RunCreateCall[])[0][0]
      .data;
    // The natural grant run is replaySeq 0 → the uniform key "<trigger>:<grantId>:0" (ADR-0057).
    expect(runData.idempotencyKey).toBe('ACCESS_GRANTED:g1:0');
    expect(runData.replaySeq).toBe(0);
    expect(runData.status).toBe('PENDING');
    expect(runData.workflowVersionId).toBe(5);
    expect(runData.executedAsServiceAccountId).toBe('sa_engine');
    // Enqueued AFTER commit with a deterministic, BullMQ-safe start jobId (idempotent; no `:` — #298).
    expect(h.queue.add).toHaveBeenCalledWith(
      'run-start',
      { runId: 'run1' },
      expect.objectContaining({ jobId: 'start-run1' }),
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

    const runData = (h.workflowRun.create.mock.calls as RunCreateCall[])[0][0]
      .data;
    expect(runData.idempotencyKey).toBe('ACCESS_REVOKED:g1:0');
    expect(h.queue.add).toHaveBeenCalled();
  });

  it('CCOR-1: takes the per-(user,app) advisory lock BEFORE counting (serializes the last-grant decision)', async () => {
    const h = build();
    h.accessGrant.findUnique.mockResolvedValue(grantRow);
    h.applicationWorkflow.findFirst.mockResolvedValue(plan()); // LAST_ACTIVE_GRANT
    h.accessGrant.update.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.accessGrant.count.mockResolvedValue(0);

    await h.service.revoke('g1', {});

    // The advisory lock is acquired (the count would race without it) and BEFORE the count, so a
    // waiter re-counts only after the holder commits.
    expect(h.executeRaw).toHaveBeenCalledTimes(1);
    expect(h.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      h.accessGrant.count.mock.invocationCallOrder[0],
    );
  });

  it('EACH_GRANT policy fires on every revoke regardless of remaining grants (no count, no lock)', async () => {
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
    // EACH_GRANT needs no last-grant decision, so it never takes the serialization lock.
    expect(h.executeRaw).not.toHaveBeenCalled();
  });
});

/**
 * CCOR-5: the in-tx PENDING-run INSERT is the one engine write in the grant's critical path (the
 * transactional-outbox tradeoff). It is determined-safe ONLY by DB invariants: a UNIQUE idempotencyKey
 * (`<trigger>:<accessGrantId>`, fresh per grant event) and FK references resolved by the pre-tx plan
 * lookup. These assertions pin those invariants AND that there is EXACTLY ONE engine write in the tx —
 * a regression guard against anyone adding a second, fallible engine write beside it (which would
 * recouple the grant to a rollback). The DB-level FK/unique enforcement itself is verified against
 * Postgres (mocked unit tests have no DB — ADR-0012).
 */
describe('CCOR-5 — the in-tx PENDING run INSERT is determined-safe by invariants', () => {
  it('grant: a single run INSERT carrying a unique idempotencyKey + resolved FK references', async () => {
    const h = build();
    h.applicationWorkflow.findFirst.mockResolvedValue(plan());
    h.accessGrant.create.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });

    await h.service.create({ userId: USER, applicationId: APP });

    // Exactly one engine write in the tx (no second fallible write may be added beside it).
    expect(h.workflowRun.create).toHaveBeenCalledTimes(1);
    const runData = (h.workflowRun.create.mock.calls as RunCreateCall[])[0][0]
      .data;
    // UNIQUE per fresh grant event — the idempotency invariant that makes the INSERT non-conflicting.
    // The natural grant run is replaySeq 0 → "<trigger>:<grantId>:0" (ADR-0057).
    expect(runData.idempotencyKey).toBe('ACCESS_GRANTED:g1:0');
    // Every FK the row carries was resolved by the pre-tx plan lookup (so the INSERT cannot dangle).
    expect(runData.accessGrantId).toBe('g1');
    expect(runData.workflowId).toBe('wf1');
    expect(runData.workflowVersionId).toBe(5);
    expect(runData.applicationId).toBe(APP);
  });

  it('revoke (fired): a single run INSERT, distinct idempotencyKey from the grant', async () => {
    const h = build();
    h.accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: null,
      userId: USER,
      applicationId: APP,
    });
    h.applicationWorkflow.findFirst.mockResolvedValue(plan());
    h.accessGrant.update.mockResolvedValue({
      id: 'g1',
      userId: USER,
      applicationId: APP,
    });
    h.accessGrant.count.mockResolvedValue(0);

    await h.service.revoke('g1', {});

    expect(h.workflowRun.create).toHaveBeenCalledTimes(1);
    const runData = (h.workflowRun.create.mock.calls as RunCreateCall[])[0][0]
      .data;
    expect(runData.idempotencyKey).toBe('ACCESS_REVOKED:g1:0');
    expect(runData.accessGrantId).toBe('g1');
    expect(runData.workflowVersionId).toBe(5);
  });
});
