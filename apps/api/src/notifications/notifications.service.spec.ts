import { Test } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';

// A stand-in PrismaClientKnownRequestError so the service's `instanceof` + `.code` checks work without
// loading the real generated client (no DB). Declared INSIDE the (hoisted) jest.mock factory, then
// re-imported below — the service only ever reads `.code`.
jest.mock('../../generated/prisma/client', () => {
  class FakePrismaKnownError extends Error {
    constructor(readonly code: string) {
      super(code);
      this.name = 'PrismaClientKnownRequestError';
    }
  }
  return {
    PrismaClient: class {},
    Prisma: { PrismaClientKnownRequestError: FakePrismaKnownError },
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Prisma } = require('../../generated/prisma/client') as {
  Prisma: { PrismaClientKnownRequestError: new (code: string) => Error };
};
const FakePrismaKnownError = Prisma.PrismaClientKnownRequestError;

const ADMIN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

type NotificationModelMock = {
  findMany: jest.Mock;
  count: jest.Mock;
  create: jest.Mock;
  deleteMany: jest.Mock;
};
type ReadModelMock = {
  create: jest.Mock;
  createMany: jest.Mock;
  deleteMany: jest.Mock;
};

describe('NotificationsService', () => {
  let service: NotificationsService;
  let notification: NotificationModelMock;
  let notificationRead: ReadModelMock;

  beforeEach(async () => {
    notification = {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      deleteMany: jest.fn(),
    };
    notificationRead = {
      create: jest.fn(),
      createMany: jest.fn(),
      deleteMany: jest.fn(),
    };
    const prisma = {
      notification,
      notificationRead,
      // findPage uses the array form ([findMany, count]).
      $transaction: jest.fn((arg: Promise<unknown>[]) => Promise.all(arg)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  // ── findPage (fan-out-on-read: per-caller read flag) ────────────────────────
  describe('findPage', () => {
    it('folds the per-caller read flag in (a read row present ⇒ read:true) and returns a Page envelope', async () => {
      const now = new Date('2026-06-09T12:00:00.000Z');
      notification.findMany.mockResolvedValue([
        {
          id: 'n1',
          type: 'low_stock',
          severity: 'warning',
          title: 'A is low',
          summary: null,
          entityType: 'consumable',
          entityId: 'c1',
          targetUserId: null,
          metadata: null,
          createdAt: now,
          reads: [{ id: 1 }], // the caller HAS read this one
        },
        {
          id: 'n2',
          type: 'admin_granted',
          severity: 'warning',
          title: 'B made admin',
          summary: 'x',
          entityType: 'application',
          entityId: 'a1',
          targetUserId: ADMIN_A,
          metadata: { k: 'v' },
          createdAt: now,
          reads: [], // unread for the caller
        },
      ]);
      notification.count.mockResolvedValue(2);

      const page = await service.findPage(ADMIN_A, {
        limit: 50,
        offset: 0,
        deleted: 'active',
      });

      expect(page).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ id: 'n1', read: true });
      expect(page.items[1]).toMatchObject({ id: 'n2', read: false });
      // createdAt is serialized to an ISO string.
      expect(page.items[0]!.createdAt).toBe('2026-06-09T12:00:00.000Z');
      // The per-caller read include scopes to THIS user (the fan-out-on-read anti-join).
      expect(notification.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { createdAt: 'desc' },
          include: { reads: { where: { userId: ADMIN_A }, select: { id: true }, take: 1 } },
        }),
      );
    });
  });

  // ── unreadCount (anti-join) ─────────────────────────────────────────────────
  describe('unreadCount', () => {
    it('counts notifications with NO read row for the caller (the anti-join)', async () => {
      notification.count.mockResolvedValue(3);
      const n = await service.unreadCount(ADMIN_A);
      expect(n).toBe(3);
      expect(notification.count).toHaveBeenCalledWith({
        where: { reads: { none: { userId: ADMIN_A } } },
      });
    });
  });

  // ── markRead (idempotent upsert) ────────────────────────────────────────────
  describe('markRead', () => {
    it('marks one read (marked:1) and returns the fresh unread count', async () => {
      notificationRead.create.mockResolvedValue({ id: 1 });
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_A, 'n1');
      expect(result).toEqual({ marked: 1, unread: 4 });
      expect(notificationRead.create).toHaveBeenCalledWith({
        data: { notificationId: 'n1', userId: ADMIN_A },
      });
    });

    it('is idempotent: an already-read row (P2002) is a clean no-op (marked:0)', async () => {
      notificationRead.create.mockRejectedValue(new FakePrismaKnownError('P2002'));
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_A, 'n1');
      expect(result).toEqual({ marked: 0, unread: 4 });
    });

    it('a missing notification (P2003 FK) is a clean no-op, never a 404', async () => {
      notificationRead.create.mockRejectedValue(new FakePrismaKnownError('P2003'));
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_A, 'gone');
      expect(result).toEqual({ marked: 0, unread: 4 });
    });

    it('re-throws an unexpected error (not P2002/P2003)', async () => {
      notificationRead.create.mockRejectedValue(new Error('boom'));
      await expect(service.markRead(ADMIN_A, 'n1')).rejects.toThrow('boom');
    });
  });

  // ── markAllRead (bulk) ──────────────────────────────────────────────────────
  describe('markAllRead', () => {
    it('inserts a read row for every currently-unread notification and reports marked + 0 unread', async () => {
      notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
      notificationRead.createMany.mockResolvedValue({ count: 2 });
      notification.count.mockResolvedValue(0);
      const result = await service.markAllRead(ADMIN_A);
      expect(result).toEqual({ marked: 2, unread: 0 });
      expect(notificationRead.createMany).toHaveBeenCalledWith({
        data: [
          { notificationId: 'n1', userId: ADMIN_A },
          { notificationId: 'n2', userId: ADMIN_A },
        ],
        skipDuplicates: true,
      });
    });

    it('short-circuits when nothing is unread (marked:0, no createMany)', async () => {
      notification.findMany.mockResolvedValue([]);
      const result = await service.markAllRead(ADMIN_A);
      expect(result).toEqual({ marked: 0, unread: 0 });
      expect(notificationRead.createMany).not.toHaveBeenCalled();
    });
  });

  // ── emit (idempotent, best-effort) ──────────────────────────────────────────
  describe('emit', () => {
    it('creates a notification and returns its id', async () => {
      notification.create.mockResolvedValue({ id: 'n9' });
      const id = await service.emit({
        type: 'low_stock',
        dedupeKey: 'low_stock:c1:2026-06-09',
        title: 'low',
        entityType: 'consumable',
        entityId: 'c1',
      });
      expect(id).toBe('n9');
      // Default severity for low_stock is `warning` when the emitter pins none.
      expect(notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'low_stock',
            dedupeKey: 'low_stock:c1:2026-06-09',
            severity: 'warning',
          }),
        }),
      );
    });

    it('is IDEMPOTENT: a dedupeKey collision (P2002) collapses to a quiet no-op (returns null, does not throw)', async () => {
      notification.create.mockRejectedValue(new FakePrismaKnownError('P2002'));
      const id = await service.emit({
        type: 'low_stock',
        dedupeKey: 'low_stock:c1:2026-06-09',
        title: 'low',
      });
      expect(id).toBeNull();
    });

    it('is BEST-EFFORT: any other failure is swallowed (returns null, never throws to the domain write)', async () => {
      notification.create.mockRejectedValue(new Error('db down'));
      const id = await service.emit({
        type: 'workflow.run_failed',
        dedupeKey: 'workflow.run_failed:r1',
        title: 'failed',
      });
      expect(id).toBeNull();
    });

    it('defaults severity per type (run_failed ⇒ critical, manual_task ⇒ info)', async () => {
      notification.create.mockResolvedValue({ id: 'x' });
      await service.emit({
        type: 'workflow.run_failed',
        dedupeKey: 'k1',
        title: 't',
      });
      await service.emit({
        type: 'workflow.manual_task',
        dedupeKey: 'k2',
        title: 't',
      });
      expect(notification.create.mock.calls[0]![0].data.severity).toBe('critical');
      expect(notification.create.mock.calls[1]![0].data.severity).toBe('info');
    });
  });
});
