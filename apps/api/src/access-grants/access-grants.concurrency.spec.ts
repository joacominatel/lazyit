jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

import { AccessGrantsService } from './access-grants.service';
import { ActorService } from '../common/actor.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';

/**
 * CCOR-1 — LAST_ACTIVE_GRANT deprovision under CONCURRENT revokes (write skew).
 *
 * A user holds the last TWO active grants on an application; two revokes run as OVERLAPPING
 * transactions. Under the Postgres default READ COMMITTED, each would fail to see the other's
 * uncommitted revoke and both count "one still active" → both skip → NEITHER fires ACCESS_REVOKED
 * (silent lingering external access). The fix takes a per-(userId, applicationId) transaction-scoped
 * advisory lock BEFORE the count, so the decision serializes and EXACTLY ONE revoke fires.
 *
 * This harness models that faithfully with a mock Prisma: a COMMITTED-state set of active grants, a
 * real async mutex standing in for `pg_advisory_xact_lock` (engaged ONLY when the code issues the
 * `$executeRaw` lock), and a two-party barrier that forces BOTH revoke UPDATEs to land before either
 * count — the exact window the write skew needs. The count reads the committed set minus the tx's own
 * (self-visible) revoke; a tx commits its revoke + releases the lock at tx end. Remove the `$executeRaw`
 * lock from the service and both counts read the same stale snapshot → zero runs → this test fails.
 */

const APP = 'app_cuid_1';
const USER = '22222222-2222-2222-2222-222222222222';

function plan() {
  return {
    id: 'wf1',
    enabled: true,
    deletedAt: null,
    executedAsServiceAccountId: 'sa_engine',
    deprovisionPolicy: 'LAST_ACTIVE_GRANT',
    versions: [{ id: 5 }],
  };
}

function buildHarness() {
  // The COMMITTED active-grant set (what a fresh READ COMMITTED snapshot sees). Both are active.
  const committedActive = new Set(['g1', 'g2']);

  // Async mutex modelling pg_advisory_xact_lock: held until the holder's tx commits/releases.
  let locked = false;
  const waiters: Array<() => void> = [];
  const acquire = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (!locked) {
        locked = true;
        resolve();
      } else {
        waiters.push(resolve);
      }
    });
  const release = (): void => {
    const next = waiters.shift();
    if (next) {
      next(); // hand off — stays locked for the next holder
    } else {
      locked = false;
    }
  };

  // Two-party barrier: both revoke UPDATEs must land before either count (opens the race window).
  let arrived = 0;
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  const barrier = async (): Promise<void> => {
    arrived += 1;
    if (arrived === 2) {
      openGate();
    }
    await gate;
  };

  const runRows: Array<Record<string, unknown>> = [];

  const grantById: Record<string, { id: string; revokedAt: Date | null }> = {
    g1: { id: 'g1', revokedAt: null },
    g2: { id: 'g2', revokedAt: null },
  };

  const applicationWorkflow = {
    findFirst: jest.fn().mockResolvedValue(plan()),
  };
  const accessGrant = {
    findUnique: jest.fn(({ where: { id } }: { where: { id: string } }) =>
      Promise.resolve(grantById[id]),
    ),
  };

  const prisma = {
    accessGrant,
    applicationWorkflow,
    $transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const ctx = { revokedId: null as string | null, holdsLock: false };
      const tx = {
        accessGrant: {
          update: async ({ where: { id } }: { where: { id: string } }) => {
            ctx.revokedId = id; // uncommitted revoke — visible only to this tx
            await barrier(); // both updates land before any count
            return {
              id,
              userId: USER,
              applicationId: APP,
              revokedAt: new Date(),
            };
          },
          count: () => {
            // active = committed active minus this tx's own (self-visible) revoke. Read happens at
            // call time (synchronously), exactly when the service issues the count under the lock.
            let n = committedActive.size;
            if (ctx.revokedId && committedActive.has(ctx.revokedId)) {
              n -= 1;
            }
            return Promise.resolve(n);
          },
        },
        workflowRun: {
          create: ({ data }: { data: Record<string, unknown> }) => {
            runRows.push(data);
            return Promise.resolve({ id: `run_${runRows.length}` });
          },
        },
        // The advisory lock. Engaged ONLY because the service issues it before the count.
        $executeRaw: async () => {
          await acquire();
          ctx.holdsLock = true;
          return 1;
        },
      };
      try {
        return await cb(tx);
      } finally {
        // Commit the revoke (delete BEFORE release, so the waiter re-counts the committed state),
        // then release the lock — both happen at tx end, exactly like pg_advisory_xact_lock.
        if (ctx.revokedId) {
          committedActive.delete(ctx.revokedId);
        }
        if (ctx.holdsLock) {
          release();
        }
      }
    }),
  };

  const queue = { add: jest.fn().mockResolvedValue({ id: 'job1' }) };
  const trigger = new WorkflowTriggerService(prisma as never, queue as never);
  // The notification emitter only fires on create() (not the revoke paths these tests exercise); a
  // no-op mock keeps the concurrency assertions unchanged.
  const notifications = { emit: jest.fn().mockResolvedValue(null) };
  const service = new AccessGrantsService(
    prisma as never,
    new ActorService(),
    trigger,
    notifications as never,
  );
  return { service, runRows, committedActive };
}

describe('CCOR-1 — concurrent last-grant revokes (write skew)', () => {
  it('two overlapping revokes of the last two grants create EXACTLY ONE ACCESS_REVOKED run', async () => {
    const h = buildHarness();

    // Both revokes run concurrently (overlapping transactions).
    await Promise.all([h.service.revoke('g1', {}), h.service.revoke('g2', {})]);

    // Without the advisory lock both would compute "one still active" and neither would fire (0 runs);
    // with it, exactly one revoke observes 0 remaining and fires the deprovision.
    expect(h.runRows).toHaveLength(1);
    expect(h.runRows[0].idempotencyKey).toMatch(/^ACCESS_REVOKED:g[12]$/);
    // Both grants are revoked regardless of which one fired the workflow.
    expect(h.committedActive.size).toBe(0);
  });
});
