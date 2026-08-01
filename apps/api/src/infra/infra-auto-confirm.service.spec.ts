import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// Mock the generated Prisma client so the test never loads the real one (no DB) — the same shim the
// sibling `infra.service.spec.ts` uses. Only the DI TOKEN is needed here; every call is mocked.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: { __dbNull: true } },
}));

import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { PrismaService } from '../prisma/prisma.service';

type Mock = jest.Mock;

/** The first argument of a mock's first call, typed — the sibling spec's helper, same reason. */
function firstArg<T>(mock: Mock): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[0][0] as T;
}

/** The first argument of a mock's Nth call, typed. */
function nthArg<T>(mock: Mock, index: number): T {
  const calls = mock.mock.calls as unknown[][];
  return calls[index][0] as T;
}

interface PrismaMock {
  infraAutoConfirmRule: {
    findFirst: Mock;
    findMany: Mock;
    create: Mock;
    update: Mock;
  };
  user: { findFirst: Mock };
}

/** A stored rule row as `RULE_SELECT` returns it (timestamps are Dates, author joined). */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    name: 'Prod servers',
    enabled: true,
    appliesTo: 'HOST',
    hostnamePattern: 'srv-*',
    subnetCidr: null,
    reportedKind: null,
    confirmAsKind: null,
    trackAsAsset: true,
    createdById: 'u-1',
    matchCount: 0,
    lastMatchedAt: null,
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    updatedAt: new Date('2026-08-01T00:00:00.000Z'),
    createdBy: { firstName: 'Ada', lastName: 'Lovelace', deletedAt: null },
    ...overrides,
  };
}

const HOST_CANDIDATE = {
  hostname: 'srv-app-04',
  ipAddress: '10.20.3.7',
  kind: 'PHYSICAL_HOST' as const,
  isContainerChild: false,
};

const HUMAN = { kind: 'human', user: { id: 'u-1' } } as never;

describe('InfraAutoConfirmService (ADR-0074 §1 amendment, #1145)', () => {
  let service: InfraAutoConfirmService;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = {
      infraAutoConfirmRule: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
      },
      user: { findFirst: jest.fn() },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InfraAutoConfirmService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(InfraAutoConfirmService);
  });

  describe('list', () => {
    it('lists oldest-first (the evaluation order) and flattens the author name', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([row()]);

      const rules = (await service.list()) as {
        createdByName: string | null;
      }[];

      expect(
        firstArg<{ orderBy: unknown }>(prisma.infraAutoConfirmRule.findMany)
          .orderBy,
      ).toEqual({ createdAt: 'asc' });
      expect(rules[0].createdByName).toBe('Ada Lovelace');
      expect(rules[0]).not.toHaveProperty('createdBy');
    });

    it('never leaks a soft-deleted author name (it reads as unattributed)', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([
        row({
          createdBy: {
            firstName: 'Ada',
            lastName: 'Lovelace',
            deletedAt: new Date(),
          },
        }),
      ]);

      const rules = (await service.list()) as {
        createdByName: string | null;
      }[];

      expect(rules[0].createdByName).toBeNull();
    });
  });

  describe('create', () => {
    it('stamps the authoring human — the attribution §8 leans on', async () => {
      prisma.infraAutoConfirmRule.create.mockResolvedValue(row());

      await service.create(
        { name: 'Prod servers', hostnamePattern: 'srv-*' },
        HUMAN,
      );

      const { data } = firstArg<{ data: { createdById: string | null } }>(
        prisma.infraAutoConfirmRule.create,
      );
      expect(data.createdById).toBe('u-1');
    });

    it('defaults trackAsAsset ON for a HOST rule and OFF for a CONTAINER rule', async () => {
      prisma.infraAutoConfirmRule.create.mockResolvedValue(row());

      await service.create({ name: 'hosts', hostnamePattern: 'srv-*' }, HUMAN);
      await service.create(
        { name: 'containers', appliesTo: 'CONTAINER', hostnamePattern: '*' },
        HUMAN,
      );

      type Call = { data: { trackAsAsset: boolean } };
      expect(
        nthArg<Call>(prisma.infraAutoConfirmRule.create, 0).data.trackAsAsset,
      ).toBe(true);
      expect(
        nthArg<Call>(prisma.infraAutoConfirmRule.create, 1).data.trackAsAsset,
      ).toBe(false);
    });

    it('honours an explicit trackAsAsset over the per-scope default', async () => {
      prisma.infraAutoConfirmRule.create.mockResolvedValue(row());

      await service.create(
        {
          name: 'licensed appliance',
          appliesTo: 'CONTAINER',
          hostnamePattern: '*',
          trackAsAsset: true,
        },
        HUMAN,
      );

      const { data } = firstArg<{ data: { trackAsAsset: boolean } }>(
        prisma.infraAutoConfirmRule.create,
      );
      expect(data.trackAsAsset).toBe(true);
    });
  });

  describe('update', () => {
    it('404s an unknown rule', async () => {
      prisma.infraAutoConfirmRule.findFirst.mockResolvedValue(null);

      await expect(
        service.update('nope', { enabled: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('REFUSES a patch that clears the last remaining condition on the MERGED rule', async () => {
      // The stored rule's only condition is `hostnamePattern`; nulling it would leave a blanket rule,
      // which the patch shape alone cannot see.
      prisma.infraAutoConfirmRule.findFirst.mockResolvedValue(row());

      await expect(
        service.update('rule-1', { hostnamePattern: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.infraAutoConfirmRule.update).not.toHaveBeenCalled();
    });

    it('allows clearing one condition while another survives', async () => {
      prisma.infraAutoConfirmRule.findFirst.mockResolvedValue(
        row({ subnetCidr: '10.20.0.0/16' }),
      );
      prisma.infraAutoConfirmRule.update.mockResolvedValue(
        row({ hostnamePattern: null }),
      );

      await service.update('rule-1', { hostnamePattern: null });

      expect(prisma.infraAutoConfirmRule.update).toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('soft-deletes (never hard-deletes) — the decision record is kept', async () => {
      prisma.infraAutoConfirmRule.findFirst.mockResolvedValue({ id: 'rule-1' });
      prisma.infraAutoConfirmRule.update.mockResolvedValue(row());

      await service.remove('rule-1');

      const { data } = firstArg<{ data: { deletedAt: Date } }>(
        prisma.infraAutoConfirmRule.update,
      );
      expect(data.deletedAt).toBeInstanceOf(Date);
    });
  });

  describe('resolve', () => {
    it('reads only ENABLED rules, oldest-first, and returns the first match', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([
        row({ id: 'rule-a', hostnamePattern: 'db-*' }),
        row({ id: 'rule-b', hostnamePattern: 'srv-*', confirmAsKind: 'VM' }),
      ]);
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      const resolved = await service.resolve(HOST_CANDIDATE);

      const args = firstArg<{ where: unknown; orderBy: unknown }>(
        prisma.infraAutoConfirmRule.findMany,
      );
      expect(args.where).toEqual({ enabled: true });
      expect(args.orderBy).toEqual({ createdAt: 'asc' });
      expect(resolved?.ruleId).toBe('rule-b');
      expect(resolved?.confirmAsKind).toBe('VM');
      expect(resolved?.author).toEqual({ kind: 'human', user: { id: 'u-1' } });
    });

    it('returns undefined when nothing matches — the node stays PENDING', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([
        row({ hostnamePattern: 'db-*' }),
      ]);

      await expect(service.resolve(HOST_CANDIDATE)).resolves.toBeUndefined();
    });

    it('an instance with NO rules resolves nothing and never reads a user', async () => {
      await expect(service.resolve(HOST_CANDIDATE)).resolves.toBeUndefined();
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    });

    it('still fires for a rule whose author was deleted, but with NO principal', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([row()]);
      // `findFirst` is soft-delete-scoped, so a deleted author resolves to null.
      prisma.user.findFirst.mockResolvedValue(null);

      const resolved = await service.resolve(HOST_CANDIDATE);

      expect(resolved?.ruleId).toBe('rule-1');
      expect(resolved?.author).toBeUndefined();
    });

    it('is READ-ONLY — resolving never writes a rule or a node', async () => {
      prisma.infraAutoConfirmRule.findMany.mockResolvedValue([row()]);
      prisma.user.findFirst.mockResolvedValue({ id: 'u-1' });

      await service.resolve(HOST_CANDIDATE);

      expect(prisma.infraAutoConfirmRule.update).not.toHaveBeenCalled();
      expect(prisma.infraAutoConfirmRule.create).not.toHaveBeenCalled();
    });

    it('exposes NO way to apply a rule to existing nodes — rules are never retroactive', () => {
      // Asserted structurally rather than behaviourally: the class has no method that could walk the
      // PENDING tray, so an operator saving a rule cannot have proposals confirm behind them.
      const methods = Object.getOwnPropertyNames(
        InfraAutoConfirmService.prototype,
      );
      expect(methods.sort()).toEqual(
        [
          'constructor',
          'create',
          'flatten',
          'list',
          'recordMatch',
          'remove',
          'resolve',
          'update',
        ].sort(),
      );
    });
  });

  describe('recordMatch', () => {
    it('increments the counter and stamps the instant', async () => {
      prisma.infraAutoConfirmRule.update.mockResolvedValue(row());

      await service.recordMatch('rule-1');

      const { data } = firstArg<{
        data: { matchCount: unknown; lastMatchedAt: Date };
      }>(prisma.infraAutoConfirmRule.update);
      expect(data.matchCount).toEqual({ increment: 1 });
      expect(data.lastMatchedAt).toBeInstanceOf(Date);
    });

    it('swallows a failure — the node is already confirmed, the counter is not worth a 500', async () => {
      prisma.infraAutoConfirmRule.update.mockRejectedValue(new Error('gone'));

      await expect(service.recordMatch('rule-1')).resolves.toBeUndefined();
    });
  });
});
