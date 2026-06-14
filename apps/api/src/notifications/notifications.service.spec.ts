import { Test } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

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
const MEMBER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// A viewer = the caller's id + role; the service resolves notification:read from the role (ADMIN → can
// read the broadcast set; MEMBER → only their own targeted rows).
const ADMIN_VIEWER = { userId: ADMIN_A, role: 'ADMIN' as const };
const MEMBER_VIEWER = { userId: MEMBER_B, role: 'MEMBER' as const };

type NotificationModelMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
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
  // Mirror the real resolver: only ADMIN holds notification:read (it is in ADMIN_ONLY_READS).
  const hasAll = jest.fn((role: string, perms: readonly string[]) =>
    Promise.resolve(
      perms.every((p) => (p === 'notification:read' ? role === 'ADMIN' : false)),
    ),
  );

  beforeEach(async () => {
    notification = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
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
        { provide: PermissionResolverService, useValue: { hasAll } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  // ── visibility scoping (the auth contract, ADR-0056 amendment #453) ──────────
  describe('visibility scoping', () => {
    it('an ADMIN sees BOTH their own targeted rows AND the broadcast set (recipientUserId = me OR null)', async () => {
      notification.findMany.mockResolvedValue([]);
      notification.count.mockResolvedValue(0);
      await service.findPage(ADMIN_VIEWER, {
        limit: 50,
        offset: 0,
        deleted: 'active',
      });
      const where = notification.findMany.mock.calls[0]![0].where;
      expect(where).toEqual({
        OR: [{ recipientUserId: ADMIN_A }, { recipientUserId: null }],
      });
      // The count is scoped by the SAME where (total can't include rows the caller can't see).
      expect(notification.count).toHaveBeenCalledWith({ where });
    });

    it('a non-admin (MEMBER) sees ONLY their own targeted rows — never the broadcast set', async () => {
      notification.findMany.mockResolvedValue([]);
      notification.count.mockResolvedValue(0);
      await service.findPage(MEMBER_VIEWER, {
        limit: 50,
        offset: 0,
        deleted: 'active',
      });
      const where = notification.findMany.mock.calls[0]![0].where;
      // No `{ recipientUserId: null }` branch ⇒ broadcast rows are invisible to a non-admin.
      expect(where).toEqual({ OR: [{ recipientUserId: MEMBER_B }] });
    });
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
          recipientUserId: null,
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
          recipientUserId: null,
          metadata: { k: 'v' },
          createdAt: now,
          reads: [], // unread for the caller
        },
      ]);
      notification.count.mockResolvedValue(2);

      const page = await service.findPage(ADMIN_VIEWER, {
        limit: 50,
        offset: 0,
        deleted: 'active',
      });

      expect(page).toMatchObject({ total: 2, limit: 50, offset: 0 });
      expect(page.items).toHaveLength(2);
      expect(page.items[0]).toMatchObject({ id: 'n1', read: true });
      expect(page.items[1]).toMatchObject({ id: 'n2', read: false });
      // recipientUserId is folded into the wire shape.
      expect(page.items[0]).toMatchObject({ recipientUserId: null });
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

  // ── unreadCount (anti-join, scoped) ─────────────────────────────────────────
  describe('unreadCount', () => {
    it('counts VISIBLE notifications with NO read row for the caller (the scoped anti-join)', async () => {
      notification.count.mockResolvedValue(3);
      const n = await service.unreadCount(ADMIN_VIEWER);
      expect(n).toBe(3);
      expect(notification.count).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ recipientUserId: ADMIN_A }, { recipientUserId: null }] },
            { reads: { none: { userId: ADMIN_A } } },
          ],
        },
      });
    });

    it('a non-admin unread count is scoped to their own targeted rows only', async () => {
      notification.count.mockResolvedValue(1);
      await service.unreadCount(MEMBER_VIEWER);
      expect(notification.count).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ recipientUserId: MEMBER_B }] },
            { reads: { none: { userId: MEMBER_B } } },
          ],
        },
      });
    });
  });

  // ── markRead (idempotent upsert, IDOR-safe) ─────────────────────────────────
  describe('markRead', () => {
    it('marks one VISIBLE notification read (marked:1) and returns the fresh unread count', async () => {
      notification.findFirst.mockResolvedValue({ id: 'n1' }); // it IS visible to the caller
      notificationRead.create.mockResolvedValue({ id: 1 });
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_VIEWER, 'n1');
      expect(result).toEqual({ marked: 1, unread: 4 });
      // The visibility gate scopes the lookup to {own targeted OR broadcast} AND the id.
      expect(notification.findFirst).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ recipientUserId: ADMIN_A }, { recipientUserId: null }] },
            { id: 'n1' },
          ],
        },
        select: { id: true },
      });
      expect(notificationRead.create).toHaveBeenCalledWith({
        data: { notificationId: 'n1', userId: ADMIN_A },
      });
    });

    it('IDOR-safe: a notification the caller CANNOT see is a clean no-op (marked:0, no read row written)', async () => {
      // Another user's targeted notif (or — for a non-admin — a broadcast row): the scoped lookup finds
      // nothing, so mark-read never writes a read row and never discloses the row's existence.
      notification.findFirst.mockResolvedValue(null);
      notification.count.mockResolvedValue(0);
      const result = await service.markRead(MEMBER_VIEWER, 'someone-elses-targeted');
      expect(result).toEqual({ marked: 0, unread: 0 });
      expect(notificationRead.create).not.toHaveBeenCalled();
    });

    it('is idempotent: an already-read VISIBLE row (P2002) is a clean no-op (marked:0)', async () => {
      notification.findFirst.mockResolvedValue({ id: 'n1' });
      notificationRead.create.mockRejectedValue(new FakePrismaKnownError('P2002'));
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_VIEWER, 'n1');
      expect(result).toEqual({ marked: 0, unread: 4 });
    });

    it('a racing retention delete (P2003 FK) on a VISIBLE row is a clean no-op, never a 404', async () => {
      notification.findFirst.mockResolvedValue({ id: 'gone' });
      notificationRead.create.mockRejectedValue(new FakePrismaKnownError('P2003'));
      notification.count.mockResolvedValue(4);
      const result = await service.markRead(ADMIN_VIEWER, 'gone');
      expect(result).toEqual({ marked: 0, unread: 4 });
    });

    it('re-throws an unexpected error (not P2002/P2003)', async () => {
      notification.findFirst.mockResolvedValue({ id: 'n1' });
      notificationRead.create.mockRejectedValue(new Error('boom'));
      await expect(service.markRead(ADMIN_VIEWER, 'n1')).rejects.toThrow('boom');
    });
  });

  // ── markAllRead (bulk, scoped) ──────────────────────────────────────────────
  describe('markAllRead', () => {
    it('inserts a read row for every currently-unread VISIBLE notification and reports marked + 0 unread', async () => {
      notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);
      notificationRead.createMany.mockResolvedValue({ count: 2 });
      notification.count.mockResolvedValue(0);
      const result = await service.markAllRead(ADMIN_VIEWER);
      expect(result).toEqual({ marked: 2, unread: 0 });
      // The unread scan is scoped: {visible} AND {no read row for the caller}.
      expect(notification.findMany).toHaveBeenCalledWith({
        where: {
          AND: [
            { OR: [{ recipientUserId: ADMIN_A }, { recipientUserId: null }] },
            { reads: { none: { userId: ADMIN_A } } },
          ],
        },
        select: { id: true },
      });
      expect(notificationRead.createMany).toHaveBeenCalledWith({
        data: [
          { notificationId: 'n1', userId: ADMIN_A },
          { notificationId: 'n2', userId: ADMIN_A },
        ],
        skipDuplicates: true,
      });
    });

    it('short-circuits when nothing visible is unread (marked:0, no createMany)', async () => {
      notification.findMany.mockResolvedValue([]);
      const result = await service.markAllRead(MEMBER_VIEWER);
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

    it('persists a TARGETED recipientUserId when the emitter sets one (ADR-0056 amendment #453)', async () => {
      notification.create.mockResolvedValue({ id: 'n10' });
      await service.emit({
        type: 'secret.vault_setup',
        dedupeKey: `secret.vault_setup:${MEMBER_B}`,
        recipientUserId: MEMBER_B,
        title: 'Set up your vault passphrase',
      });
      expect(notification.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'secret.vault_setup',
            recipientUserId: MEMBER_B,
            severity: 'info', // default for secret.vault_setup
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
