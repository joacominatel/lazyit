import { Test } from '@nestjs/testing';
import { UserHistoryService } from './user-history.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type UserHistoryMock = { create: jest.Mock; findMany: jest.Mock };

describe('UserHistoryService', () => {
  let service: UserHistoryService;
  let userHistory: UserHistoryMock;

  beforeEach(async () => {
    userHistory = { create: jest.fn(), findMany: jest.fn() };
    const prisma = { userHistory };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserHistoryService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(UserHistoryService);
  });

  describe('record (actor attribution — ADR-0048 at-most-one-actor)', () => {
    // The structural UserHistoryWriter the service appends through (PrismaService or a $transaction
    // client). Wraps the `userHistory` mock so the service's `client.userHistory.create(...)` resolves.
    let client: { userHistory: UserHistoryMock };

    beforeEach(() => {
      client = { userHistory };
    });

    it('maps a HUMAN actor to performedById (never serviceAccountId)', () => {
      service.record(client, {
        userId: 'subject-1',
        eventType: 'ROLE_CHANGED',
        payload: { from: 'VIEWER', to: 'MEMBER' },
        actor: { userId: 'actor-9' },
      });

      expect(userHistory.create).toHaveBeenCalledWith({
        data: {
          userId: 'subject-1',
          eventType: 'ROLE_CHANGED',
          payload: { from: 'VIEWER', to: 'MEMBER' },
          performedById: 'actor-9',
        },
      });
      const data = userHistory.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('serviceAccountId');
    });

    it('maps a SERVICE-ACCOUNT actor to serviceAccountId (never performedById)', () => {
      service.record(client, {
        userId: 'subject-1',
        eventType: 'DELETED',
        actor: { serviceAccountId: 'sa-7' },
      });

      const data = userHistory.create.mock.calls[0][0].data;
      expect(data.serviceAccountId).toBe('sa-7');
      expect(data).not.toHaveProperty('performedById');
    });

    it('leaves BOTH actor FKs null for a system/unknown actor (no actor passed)', () => {
      service.record(client, {
        userId: 'subject-1',
        eventType: 'CREATED',
      });

      const data = userHistory.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('performedById');
      expect(data).not.toHaveProperty('serviceAccountId');
      expect(data).toEqual({ userId: 'subject-1', eventType: 'CREATED' });
    });

    it('omits payload when none is provided', () => {
      service.record(client, {
        userId: 'subject-1',
        eventType: 'PASSWORD_RESET_SENT',
        actor: { userId: 'actor-9' },
      });

      const data = userHistory.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('payload');
    });

    it('records through the GIVEN client (a transaction client), not a fixed prisma reference', () => {
      const tx = { userHistory: { create: jest.fn(), findMany: jest.fn() } };
      service.record(tx as never, {
        userId: 'subject-1',
        eventType: 'UPDATED',
        actor: { userId: 'actor-9' },
      });

      // The tx client receives the write; the base prisma client is untouched (atomicity, ADR-0033).
      expect(tx.userHistory.create).toHaveBeenCalledTimes(1);
      expect(userHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns a user page newest-first with an optional exclusive id cursor', async () => {
      userHistory.findMany.mockResolvedValue([]);

      await service.list('subject-1', { limit: 25, before: 100 });

      expect(userHistory.findMany).toHaveBeenCalledWith({
        where: { userId: 'subject-1', id: { lt: 100 } },
        orderBy: { id: 'desc' },
        take: 25,
      });
    });

    it('omits the cursor filter when no `before` is given', async () => {
      userHistory.findMany.mockResolvedValue([]);

      await service.list('subject-1', { limit: 50 });

      expect(userHistory.findMany).toHaveBeenCalledWith({
        where: { userId: 'subject-1' },
        orderBy: { id: 'desc' },
        take: 50,
      });
    });
  });
});
