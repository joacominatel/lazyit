import { Test } from '@nestjs/testing';
import { WORKFLOW_RUN_STATUSES, type WorkflowRunStatus } from '@lazyit/shared';
import { AccessGrantsService } from './access-grants.service';
import {
  provisioningByGrant,
  provisioningFromRunStatus,
} from './grant-provisioning';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { WorkflowTriggerService } from '../workflow-engine/run/workflow-trigger.service';
import { NotificationsService } from '../notifications/notifications.service';

// No DB: the service uses `Prisma` only for types.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * The coarse requester-facing provisioning status (#1700, CEO decision Q2 on #1344): derived from the
 * latest ACCESS_GRANTED run linked to a grant, mapped to four values, and read in ONE batched query.
 */
describe('provisioningFromRunStatus — the run → coarse status mapping', () => {
  it.each<[WorkflowRunStatus | null | undefined, string]>([
    [undefined, 'NONE'],
    [null, 'NONE'],
    ['PENDING', 'IN_PROGRESS'],
    ['RUNNING', 'IN_PROGRESS'],
    ['SUCCEEDED', 'DONE'],
    ['AWAITING_INPUT', 'WAITING_ON_IT'],
    ['FAILED', 'WAITING_ON_IT'],
    ['COMPENSATED', 'WAITING_ON_IT'],
  ])('%s → %s', (status, expected) => {
    expect(provisioningFromRunStatus(status)).toBe(expected);
  });

  it('maps every run state the engine has (no state falls through unmapped)', () => {
    const mapped = new Set(['IN_PROGRESS', 'DONE', 'WAITING_ON_IT']);
    for (const status of WORKFLOW_RUN_STATUSES) {
      expect(mapped.has(provisioningFromRunStatus(status))).toBe(true);
    }
  });
});

describe('provisioningByGrant', () => {
  it('takes the FIRST (latest) run per grant and NONE for a grant without one', () => {
    const result = provisioningByGrant(
      ['g1', 'g2', 'g3'],
      [
        // Ordered newest first: g1's replay succeeded after its organic run failed.
        { accessGrantId: 'g1', status: 'SUCCEEDED' },
        { accessGrantId: 'g2', status: 'AWAITING_INPUT' },
        { accessGrantId: 'g1', status: 'FAILED' },
      ],
    );
    expect(Object.fromEntries(result)).toEqual({
      g1: 'DONE',
      g2: 'WAITING_ON_IT',
      g3: 'NONE',
    });
  });
});

describe('AccessGrantsService — provisioning reads', () => {
  let service: AccessGrantsService;
  let accessGrant: { findMany: jest.Mock; count: jest.Mock };
  let workflowRun: { findMany: jest.Mock };

  beforeEach(async () => {
    accessGrant = { findMany: jest.fn(), count: jest.fn() };
    workflowRun = { findMany: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessGrantsService,
        {
          provide: PrismaService,
          useValue: {
            accessGrant,
            workflowRun,
            $transaction: jest.fn((queries: Array<Promise<unknown>>) =>
              Promise.all(queries),
            ),
          },
        },
        { provide: ActorService, useValue: new ActorService() },
        { provide: WorkflowTriggerService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(AccessGrantsService);
  });

  it('reads the runs of a whole page in ONE query, provisioning runs only, latest first, status only', async () => {
    workflowRun.findMany.mockResolvedValue([
      { accessGrantId: 'g1', status: 'RUNNING' },
    ]);

    const result = await service.provisioningFor(['g1', 'g2']);

    expect(workflowRun.findMany).toHaveBeenCalledTimes(1);
    expect(workflowRun.findMany).toHaveBeenCalledWith({
      where: { accessGrantId: { in: ['g1', 'g2'] }, trigger: 'ACCESS_GRANTED' },
      // Nothing but the grant id and the status: no workflow name, step or error is read.
      select: { accessGrantId: true, status: true },
      orderBy: [{ replaySeq: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(Object.fromEntries(result)).toEqual({
      g1: 'IN_PROGRESS',
      g2: 'NONE',
    });
  });

  it('skips the run read for an empty page', async () => {
    const result = await service.provisioningFor([]);
    expect(result.size).toBe(0);
    expect(workflowRun.findMany).not.toHaveBeenCalled();
  });

  it('findMine scopes to the caller and adds provisioning to every grant of the page', async () => {
    accessGrant.findMany.mockResolvedValue([
      { id: 'g1', userId: 'u1' },
      { id: 'g2', userId: 'u1' },
    ]);
    accessGrant.count.mockResolvedValue(2);
    workflowRun.findMany.mockResolvedValue([
      { accessGrantId: 'g2', status: 'FAILED' },
    ]);

    const page = await service.findMine(
      'u1',
      { activeOnly: false, includeExpired: true },
      { limit: 50, offset: 0 } as never,
    );

    const [findArgs] = accessGrant.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(findArgs.where).toMatchObject({ userId: 'u1' });
    expect(page).toEqual({
      items: [
        { id: 'g1', userId: 'u1', provisioning: 'NONE' },
        { id: 'g2', userId: 'u1', provisioning: 'WAITING_ON_IT' },
      ],
      total: 2,
      limit: 50,
      offset: 0,
    });
    // Page + count in one transaction, then exactly one run read: no N+1.
    expect(workflowRun.findMany).toHaveBeenCalledTimes(1);
  });
});
