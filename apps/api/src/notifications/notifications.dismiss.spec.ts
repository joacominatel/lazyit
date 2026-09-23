import { Test } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import {
  NOTIFICATION_RETENTION_MS,
  NotificationsRetentionSweeper,
} from './notifications-retention.sweeper';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { Prisma } from '../../generated/prisma/client';

// The DB is faked with an in-memory store below, so stub the generated client. The stand-in known-error
// class lets the service's `instanceof` + `.code` checks see the P2002/P2003 the double throws.
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

const KnownError = Prisma.PrismaClientKnownRequestError as unknown as new (
  code: string,
) => Error;

/** Run a synchronous store operation as a Prisma-like promise: a throw becomes a rejection. */
const later = <T>(op: () => T): Promise<T> =>
  new Promise<T>((resolve) => resolve(op()));

const ADMIN_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ADMIN_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MEMBER_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const ADMIN_A_VIEWER = { userId: ADMIN_A, role: 'ADMIN' as const };
const ADMIN_C_VIEWER = { userId: ADMIN_C, role: 'ADMIN' as const };
const MEMBER_B_VIEWER = { userId: MEMBER_B, role: 'MEMBER' as const };

const PAGE = { limit: 50, offset: 0, deleted: 'active' as const };

// ── in-memory Prisma double ───────────────────────────────────────────────────────
// Implements ONLY the notification / notificationRead operations the service and the retention sweeper
// call, and evaluates their `where` shapes. An unknown filter key throws, so a query shape this double
// does not understand fails the test instead of silently matching.

interface NotificationRow {
  id: string;
  type: string;
  severity: string;
  dedupeKey: string;
  title: string;
  summary: string | null;
  entityType: string | null;
  entityId: string | null;
  targetUserId: string | null;
  recipientUserId: string | null;
  metadata: unknown;
  createdAt: Date;
}

interface ReadRow {
  id: number;
  notificationId: string;
  userId: string;
  readAt: Date;
  dismissedAt: Date | null;
}

type Where = Record<string, unknown>;

class InMemoryNotificationsDb {
  notifications: NotificationRow[] = [];
  reads: ReadRow[] = [];
  private readSeq = 1;
  private notifSeq = 1;

  seed(
    partial: Partial<NotificationRow> & { id: string; createdAt?: Date },
  ): NotificationRow {
    const row: NotificationRow = {
      type: 'low_stock',
      severity: 'warning',
      dedupeKey: `seed:${partial.id}`,
      title: partial.id,
      summary: null,
      entityType: null,
      entityId: null,
      targetUserId: null,
      recipientUserId: null,
      metadata: null,
      createdAt: new Date(),
      ...partial,
    };
    this.notifications.push(row);
    return row;
  }

  readOf(notificationId: string, userId: string): ReadRow | undefined {
    return this.reads.find(
      (r) => r.notificationId === notificationId && r.userId === userId,
    );
  }

  private matchNotification(n: NotificationRow, where: Where): boolean {
    return Object.entries(where).every(([key, value]) => {
      switch (key) {
        case 'AND':
          return (value as Where[]).every((w) => this.matchNotification(n, w));
        case 'OR':
          return (value as Where[]).some((w) => this.matchNotification(n, w));
        case 'id':
        case 'recipientUserId':
          return n[key] === value;
        case 'createdAt':
          return n.createdAt < (value as { lt: Date }).lt;
        case 'reads': {
          const { none } = value as { none: Where };
          return !this.reads.some(
            (r) => r.notificationId === n.id && this.matchRead(r, none),
          );
        }
        default:
          throw new Error(
            `in-memory double: unsupported notification filter ${key}`,
          );
      }
    });
  }

  private matchRead(r: ReadRow, where: Where): boolean {
    return Object.entries(where).every(([key, value]) => {
      switch (key) {
        case 'userId':
          return r.userId === value;
        case 'notificationId':
          return typeof value === 'string'
            ? r.notificationId === value
            : (value as { in: string[] }).in.includes(r.notificationId);
        case 'dismissedAt':
          if (value === null) return r.dismissedAt === null;
          if (
            typeof value === 'object' &&
            value !== null &&
            'not' in value &&
            value.not === null
          ) {
            return r.dismissedAt !== null;
          }
          throw new Error('in-memory double: unsupported dismissedAt filter');
        case 'notification': {
          const parent = this.notifications.find(
            (n) => n.id === r.notificationId,
          );
          return !!parent && this.matchNotification(parent, value as Where);
        }
        default:
          throw new Error(`in-memory double: unsupported read filter ${key}`);
      }
    });
  }

  private insertRead(data: {
    notificationId: string;
    userId: string;
    dismissedAt?: Date;
  }): ReadRow {
    if (this.readOf(data.notificationId, data.userId)) {
      throw new KnownError('P2002');
    }
    if (!this.notifications.some((n) => n.id === data.notificationId)) {
      throw new KnownError('P2003');
    }
    const row: ReadRow = {
      id: this.readSeq++,
      notificationId: data.notificationId,
      userId: data.userId,
      readAt: new Date(),
      dismissedAt: data.dismissedAt ?? null,
    };
    this.reads.push(row);
    return row;
  }

  client() {
    const pick = (row: NotificationRow, select?: Record<string, boolean>) =>
      select
        ? Object.fromEntries(
            Object.keys(select).map((k) => [
              k,
              row[k as keyof NotificationRow],
            ]),
          )
        : { ...row };

    const notification = {
      findMany: (args: {
        where: Where;
        orderBy?: { createdAt: 'desc' };
        take?: number;
        skip?: number;
        select?: Record<string, boolean>;
        include?: { reads: { where: Where; take: number } };
      }) =>
        later(() => {
          let rows = this.notifications.filter((n) =>
            this.matchNotification(n, args.where),
          );
          if (args.orderBy) {
            rows = [...rows].sort(
              (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
            );
          }
          rows = rows.slice(
            args.skip ?? 0,
            (args.skip ?? 0) + (args.take ?? rows.length),
          );
          return rows.map((n) => {
            if (args.include) {
              const reads = this.reads
                .filter(
                  (r) =>
                    r.notificationId === n.id &&
                    this.matchRead(r, args.include!.reads.where),
                )
                .slice(0, args.include.reads.take)
                .map((r) => ({ id: r.id }));
              return { ...n, reads };
            }
            return pick(n, args.select);
          });
        }),
      findFirst: (args: { where: Where; select?: Record<string, boolean> }) =>
        later(() => {
          const row = this.notifications.find((n) =>
            this.matchNotification(n, args.where),
          );
          return row ? pick(row, args.select) : null;
        }),
      count: (args: { where: Where }) =>
        later(
          () =>
            this.notifications.filter((n) =>
              this.matchNotification(n, args.where),
            ).length,
        ),
      create: (args: {
        data: Partial<NotificationRow> & { dedupeKey: string };
      }) =>
        later(() => {
          if (
            this.notifications.some((n) => n.dedupeKey === args.data.dedupeKey)
          ) {
            throw new KnownError('P2002');
          }
          const row = this.seed({
            id: `emitted-${this.notifSeq++}`,
            ...args.data,
          });
          return { id: row.id };
        }),
      // RESTRICT on the read join: deleting an event that still has read rows is a FK violation.
      deleteMany: (args: { where: Where }) =>
        later(() => {
          const doomed = this.notifications.filter((n) =>
            this.matchNotification(n, args.where),
          );
          if (
            this.reads.some((r) =>
              doomed.some((n) => n.id === r.notificationId),
            )
          ) {
            throw new KnownError('P2003');
          }
          this.notifications = this.notifications.filter(
            (n) => !doomed.includes(n),
          );
          return { count: doomed.length };
        }),
    };

    const notificationRead = {
      create: (args: {
        data: { notificationId: string; userId: string; dismissedAt?: Date };
      }) => later(() => this.insertRead(args.data)),
      createMany: (args: {
        data: { notificationId: string; userId: string; dismissedAt?: Date }[];
        skipDuplicates?: boolean;
      }) =>
        later(() => {
          let count = 0;
          for (const data of args.data) {
            if (
              args.skipDuplicates &&
              this.readOf(data.notificationId, data.userId)
            ) {
              continue;
            }
            this.insertRead(data);
            count++;
          }
          return { count };
        }),
      updateMany: (args: { where: Where; data: { dismissedAt: Date } }) =>
        later(() => {
          const rows = this.reads.filter((r) => this.matchRead(r, args.where));
          rows.forEach((r) => {
            r.dismissedAt = args.data.dismissedAt;
          });
          return { count: rows.length };
        }),
      deleteMany: (args: { where: Where }) =>
        later(() => {
          const before = this.reads.length;
          this.reads = this.reads.filter((r) => !this.matchRead(r, args.where));
          return { count: before - this.reads.length };
        }),
    };

    return {
      notification,
      notificationRead,
      // Array form only — each entry is an already-started promise against this same store.
      $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
    };
  }
}

/**
 * Per-user DISMISS (ADR-0056 §7 amendment, issue #1309), exercised against an in-memory store so the
 * assertions are about what each user SEES, not about query shapes. Dismiss hides a notification from the
 * caller's own bell only: the shared event is never touched, other users still see it, dismiss implies
 * read, the visibility gate is the same one mark-read uses, and the retention sweep still prunes events
 * whose read joins carry a dismiss stamp.
 */
describe('NotificationsService — per-user dismiss (#1309)', () => {
  let db: InMemoryNotificationsDb;
  let client: ReturnType<InMemoryNotificationsDb['client']>;
  let service: NotificationsService;

  // Mirror the real resolver: only ADMIN holds notification:read (ADMIN_ONLY_READS).
  const hasAll = (role: string, perms: readonly string[]) =>
    Promise.resolve(
      perms.every((p) =>
        p === 'notification:read' ? role === 'ADMIN' : false,
      ),
    );

  const ids = async (viewer: typeof ADMIN_A_VIEWER | typeof MEMBER_B_VIEWER) =>
    (await service.findPage(viewer, PAGE)).items.map((n) => n.id);

  beforeEach(async () => {
    db = new InMemoryNotificationsDb();
    const t0 = Date.now();
    // Two broadcasts (admin feed) + one targeted row per user. Newest-first order: t-b, t-a, n2, n1.
    db.seed({ id: 'n1', createdAt: new Date(t0 - 4000) });
    db.seed({ id: 'n2', createdAt: new Date(t0 - 3000) });
    db.seed({
      id: 't-a',
      recipientUserId: ADMIN_A,
      createdAt: new Date(t0 - 2000),
    });
    db.seed({
      id: 't-b',
      recipientUserId: MEMBER_B,
      createdAt: new Date(t0 - 1000),
    });

    client = db.client();
    const moduleRef = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: client },
        { provide: PermissionResolverService, useValue: { hasAll } },
      ],
    }).compile();
    service = moduleRef.get(NotificationsService);
  });

  describe('dismiss one', () => {
    it("hides a broadcast from the caller's bell only — another admin still sees it, and the event row is untouched", async () => {
      const eventBefore = { ...db.notifications.find((n) => n.id === 'n1')! };

      const result = await service.dismiss(ADMIN_A_VIEWER, 'n1');

      expect(result.dismissed).toBe(1);
      expect(await ids(ADMIN_A_VIEWER)).toEqual(['t-a', 'n2']);
      expect((await service.findPage(ADMIN_A_VIEWER, PAGE)).total).toBe(2);
      // Another admin: unaffected, still unread.
      const other = await service.findPage(ADMIN_C_VIEWER, PAGE);
      expect(other.items.map((n) => n.id)).toEqual(['n2', 'n1']);
      expect(other.items.find((n) => n.id === 'n1')!.read).toBe(false);
      expect(await service.unreadCount(ADMIN_C_VIEWER)).toBe(2);
      // The shared event is neither deleted nor mutated.
      expect(db.notifications.find((n) => n.id === 'n1')).toEqual(eventBefore);
    });

    it('implies read: the unread count drops and the read join carries both readAt and dismissedAt', async () => {
      expect(await service.unreadCount(ADMIN_A_VIEWER)).toBe(3);

      const result = await service.dismiss(ADMIN_A_VIEWER, 'n2');

      expect(result).toEqual({ dismissed: 1, unread: 2 });
      expect(await service.unreadCount(ADMIN_A_VIEWER)).toBe(2);
      const join = db.readOf('n2', ADMIN_A)!;
      expect(join.readAt).toBeInstanceOf(Date);
      expect(join.dismissedAt).toBeInstanceOf(Date);
    });

    it('keeps the original readAt when dismissing a notification the caller already read', async () => {
      await service.markRead(ADMIN_A_VIEWER, 'n1');
      const readAt = new Date('2026-01-01T00:00:00.000Z');
      db.readOf('n1', ADMIN_A)!.readAt = readAt;

      const result = await service.dismiss(ADMIN_A_VIEWER, 'n1');

      expect(result.dismissed).toBe(1);
      expect(db.readOf('n1', ADMIN_A)!.readAt).toBe(readAt);
      expect(db.readOf('n1', ADMIN_A)!.dismissedAt).toBeInstanceOf(Date);
      expect(db.reads.filter((r) => r.notificationId === 'n1')).toHaveLength(1);
      expect(await ids(ADMIN_A_VIEWER)).not.toContain('n1');
    });

    it('is idempotent: a re-dismiss reports 0 and keeps the first dismissedAt', async () => {
      await service.dismiss(ADMIN_A_VIEWER, 'n1');
      const firstStamp = new Date('2026-02-02T00:00:00.000Z');
      db.readOf('n1', ADMIN_A)!.dismissedAt = firstStamp;

      const again = await service.dismiss(ADMIN_A_VIEWER, 'n1');

      expect(again).toEqual({ dismissed: 0, unread: 2 });
      expect(db.readOf('n1', ADMIN_A)!.dismissedAt).toBe(firstStamp);
      expect(db.reads).toHaveLength(1);
    });

    it("cannot dismiss another user's targeted notification — no-op, nothing written, the recipient still sees it", async () => {
      const result = await service.dismiss(ADMIN_A_VIEWER, 't-b');

      expect(result).toEqual({ dismissed: 0, unread: 3 });
      expect(db.reads).toHaveLength(0);
      expect(await ids(MEMBER_B_VIEWER)).toEqual(['t-b']);
    });

    it('a non-admin cannot dismiss a broadcast row (outside their visible set) — no-op, nothing written', async () => {
      const result = await service.dismiss(MEMBER_B_VIEWER, 'n1');

      expect(result).toEqual({ dismissed: 0, unread: 1 });
      expect(db.reads).toHaveLength(0);
      expect(await ids(ADMIN_A_VIEWER)).toContain('n1');
    });

    it('answers an invisible id and a nonexistent id identically (existence is not disclosed)', async () => {
      const invisible = await service.dismiss(MEMBER_B_VIEWER, 't-a');
      const missing = await service.dismiss(MEMBER_B_VIEWER, 'no-such-id');

      expect(invisible).toEqual(missing);
      expect(invisible).toEqual({ dismissed: 0, unread: 1 });
    });

    it('a racing retention delete between the visibility check and the write is a clean no-op', async () => {
      // The visibility check saw the row; the sweep removed it before the read join was written.
      jest
        .spyOn(client.notification, 'findFirst')
        .mockResolvedValueOnce({ id: 'pruned' });

      const result = await service.dismiss(ADMIN_A_VIEWER, 'pruned');

      expect(result.dismissed).toBe(0);
      expect(db.reads).toHaveLength(0);
    });

    it('a later mark-read or mark-all-read leaves a dismissed row dismissed', async () => {
      await service.dismiss(ADMIN_A_VIEWER, 'n1');

      expect((await service.markRead(ADMIN_A_VIEWER, 'n1')).marked).toBe(0);
      await service.markAllRead(ADMIN_A_VIEWER);

      expect(db.readOf('n1', ADMIN_A)!.dismissedAt).toBeInstanceOf(Date);
      expect(await ids(ADMIN_A_VIEWER)).not.toContain('n1');
    });
  });

  describe('dismiss all', () => {
    it("dismisses only the caller's visible rows — never another user's targeted row, never a broadcast for a non-admin", async () => {
      const result = await service.dismissAll(MEMBER_B_VIEWER);

      expect(result).toEqual({ dismissed: 1, unread: 0 });
      expect(await ids(MEMBER_B_VIEWER)).toEqual([]);
      // Only B's own targeted row got a join; the broadcasts and A's targeted row are untouched.
      expect(db.reads.map((r) => [r.notificationId, r.userId])).toEqual([
        ['t-b', MEMBER_B],
      ]);
      expect(await ids(ADMIN_A_VIEWER)).toEqual(['t-a', 'n2', 'n1']);
    });

    it("an admin's dismiss-all clears their bell (broadcasts + own targeted) and leaves other users' bells as they were", async () => {
      await service.markRead(ADMIN_A_VIEWER, 'n2');
      const readAt = new Date('2026-03-03T00:00:00.000Z');
      db.readOf('n2', ADMIN_A)!.readAt = readAt;

      const result = await service.dismissAll(ADMIN_A_VIEWER);

      expect(result).toEqual({ dismissed: 3, unread: 0 });
      expect((await service.findPage(ADMIN_A_VIEWER, PAGE)).total).toBe(0);
      expect(await service.unreadCount(ADMIN_A_VIEWER)).toBe(0);
      // The already-read row was stamped in place, not duplicated, and kept its readAt.
      expect(db.readOf('n2', ADMIN_A)!.readAt).toBe(readAt);
      expect(db.reads.filter((r) => r.userId === ADMIN_A)).toHaveLength(3);
      expect(db.readOf('t-b', ADMIN_A)).toBeUndefined();
      // Other users: unchanged.
      expect(await ids(ADMIN_C_VIEWER)).toEqual(['n2', 'n1']);
      expect(await ids(MEMBER_B_VIEWER)).toEqual(['t-b']);
    });

    it('a notification emitted after dismiss-all still shows up, unread', async () => {
      await service.dismissAll(ADMIN_A_VIEWER);

      const newId = await service.emit({
        type: 'low_stock',
        dedupeKey: 'low_stock:c9:2026-09-23',
        title: 'C9 is low',
      });

      expect(await ids(ADMIN_A_VIEWER)).toEqual([newId]);
      expect(await service.unreadCount(ADMIN_A_VIEWER)).toBe(1);
    });

    it('is idempotent: with nothing left to dismiss it reports 0 and writes nothing', async () => {
      await service.dismissAll(ADMIN_A_VIEWER);
      const readsBefore = db.reads.map((r) => ({ ...r }));

      const again = await service.dismissAll(ADMIN_A_VIEWER);

      expect(again).toEqual({ dismissed: 0, unread: 0 });
      expect(db.reads).toEqual(readsBefore);
    });
  });

  describe('retention sweep with dismissed joins', () => {
    it('still prunes an expired event whose read join carries a dismiss stamp, and keeps recent dismissed joins', async () => {
      db.seed({
        id: 'old',
        createdAt: new Date(Date.now() - NOTIFICATION_RETENTION_MS - 60_000),
      });
      await service.dismiss(ADMIN_A_VIEWER, 'old');
      await service.dismiss(ADMIN_A_VIEWER, 'n1');
      const sweeper = new NotificationsRetentionSweeper(
        client as unknown as PrismaService,
      );

      const pruned = await sweeper.sweep();

      expect(pruned).toBe(1);
      expect(db.notifications.map((n) => n.id)).not.toContain('old');
      expect(db.reads.some((r) => r.notificationId === 'old')).toBe(false);
      expect(db.readOf('n1', ADMIN_A)!.dismissedAt).toBeInstanceOf(Date);
      expect(await ids(ADMIN_A_VIEWER)).not.toContain('n1');
    });
  });
});
