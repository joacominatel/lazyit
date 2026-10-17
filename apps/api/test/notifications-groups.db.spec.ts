// Wipes the notification tables: DB_TEST_URL must be a throwaway, migrated Postgres (`bun run test:db`).
import { PageQuerySchema } from '@lazyit/shared';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  NotificationsService,
  type NotificationViewer,
} from '../src/notifications/notifications.service';
import type { PermissionResolverService } from '../src/auth/permission-resolver.service';

const URL = process.env.DB_TEST_URL;

const ADMIN_A = 'a1649aaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_C = 'c1649ccc-cccc-4ccc-8ccc-cccccccccccc';
const MEMBER_B = 'b1649bbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const A: NotificationViewer = { userId: ADMIN_A, role: 'ADMIN' };
const C: NotificationViewer = { userId: ADMIN_C, role: 'ADMIN' };
const B: NotificationViewer = { userId: MEMBER_B, role: 'MEMBER' };

const BA = 'America/Argentina/Buenos_Aires';
const page = (limit: number, offset = 0) =>
  PageQuerySchema.parse({ limit: String(limit), offset: String(offset) });

describe('grouped notifications against Postgres (#1649)', () => {
  let prisma: PrismaService;
  let service: NotificationsService;
  let seq = 0;

  const seed = async (
    type: string,
    at: string,
    opts: { recipient?: string; id?: string } = {},
  ): Promise<string> => {
    const id = opts.id ?? `g1649-${String(++seq).padStart(4, '0')}`;
    await prisma.notification.create({
      data: {
        id,
        type,
        dedupeKey: id,
        title: `${type} ${id}`,
        createdAt: new Date(at),
        ...(opts.recipient ? { recipientUserId: opts.recipient } : {}),
      },
    });
    return id;
  };

  const readsOf = async (userId: string) =>
    (
      await prisma.notificationRead.findMany({
        where: { userId },
        select: { notificationId: true },
      })
    )
      .map((r) => r.notificationId)
      .sort();

  beforeAll(async () => {
    if (!URL) {
      throw new Error(
        'DB_TEST_URL is not set: this suite needs a throwaway, migrated Postgres',
      );
    }
    process.env.DATABASE_URL = URL;
    prisma = new PrismaService();
    const permissions = {
      hasAll: (role: string) => Promise.resolve(role === 'ADMIN'),
    } as unknown as PermissionResolverService;
    service = new NotificationsService(prisma, permissions);
    for (const [id, name] of [
      [ADMIN_A, 'a'],
      [ADMIN_C, 'c'],
      [MEMBER_B, 'b'],
    ]) {
      await prisma.$executeRaw`
        INSERT INTO users (id, email, "firstName", "lastName", "updatedAt")
        VALUES (${id}::uuid, ${`${name}-1649@test.invalid`}, ${name}, ${name}, now())
        ON CONFLICT (id) DO NOTHING`;
    }
  });

  beforeEach(async () => {
    seq = 0;
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.notificationRead.deleteMany({});
    await prisma.notification.deleteMany({});
    await prisma.$executeRaw`DELETE FROM users WHERE id IN (${ADMIN_A}::uuid, ${ADMIN_C}::uuid, ${MEMBER_B}::uuid)`;
    await prisma.$disconnect();
  });

  it('groups by type and UTC day, newest group first, with counts and a newest-first preview', async () => {
    const x1 = await seed('critical_app_access', '2026-10-16T09:00:00.000Z');
    const x2 = await seed('critical_app_access', '2026-10-17T08:00:00.000Z');
    const x3 = await seed('critical_app_access', '2026-10-17T09:00:00.000Z');
    const x4 = await seed('critical_app_access', '2026-10-17T10:00:00.000Z');
    const x5 = await seed('critical_app_access', '2026-10-17T11:00:00.000Z');
    const y1 = await seed('low_stock', '2026-10-17T10:30:00.000Z');
    await service.markRead(A, x5);

    const result = await service.findGroups(A, 'UTC', page(50));

    expect(result.total).toBe(3);
    expect(result.items.map((g) => [g.type, g.day, g.count, g.unread])).toEqual(
      [
        ['critical_app_access', '2026-10-17', 4, 3],
        ['low_stock', '2026-10-17', 1, 1],
        ['critical_app_access', '2026-10-16', 1, 1],
      ],
    );
    const [today, stock, yesterday] = result.items;
    expect(today.latestAt).toBe('2026-10-17T11:00:00.000Z');
    expect(today.latest.map((n) => n.id)).toEqual([x5, x4, x3]);
    expect(today.latest.map((n) => n.read)).toEqual([true, false, false]);
    expect(stock.latest.map((n) => n.id)).toEqual([y1]);
    expect(yesterday.latest.map((n) => n.id)).toEqual([x1]);
    expect(today.latest.some((n) => n.id === x2)).toBe(false);
  });

  it('buckets days in the requested zone: one millisecond either side of local midnight', async () => {
    const before = await seed(
      'critical_app_access',
      '2026-10-17T02:59:59.999Z',
    );
    const after = await seed('critical_app_access', '2026-10-17T03:00:00.000Z');

    const utc = await service.findGroups(A, 'UTC', page(50));
    expect(utc.items.map((g) => [g.day, g.count])).toEqual([['2026-10-17', 2]]);

    const local = await service.findGroups(A, BA, page(50));
    expect(local.items.map((g) => [g.day, g.count])).toEqual([
      ['2026-10-17', 1],
      ['2026-10-16', 1],
    ]);
    expect(local.items[0].latest[0].id).toBe(after);
    expect(local.items[1].latest[0].id).toBe(before);

    const items = await service.findGroupItems(
      A,
      { type: 'critical_app_access', day: '2026-10-16', tz: BA },
      page(50),
    );
    expect(items.items.map((n) => n.id)).toEqual([before]);
    expect(items.total).toBe(1);

    await service.markGroupRead(A, {
      type: 'critical_app_access',
      day: '2026-10-16',
      tz: BA,
    });
    expect(await readsOf(ADMIN_A)).toEqual([before]);
  });

  it('pages groups without gaps or repeats when groups tie on their newest timestamp', async () => {
    const at = '2026-10-17T12:00:00.000Z';
    for (const type of [
      'low_stock',
      'admin_granted',
      'critical_app_access',
      'workflow.run_failed',
    ]) {
      await seed(type, at);
    }
    await seed('low_stock', '2026-10-16T12:00:00.000Z');
    await seed('admin_granted', '2026-10-15T12:00:00.000Z');

    const all = await service.findGroups(A, 'UTC', page(50));
    expect(all.total).toBe(6);
    const key = (g: { type: string; day: string }) => `${g.type}|${g.day}`;
    expect(all.items.slice(0, 4).map((g) => g.type)).toEqual([
      'admin_granted',
      'critical_app_access',
      'low_stock',
      'workflow.run_failed',
    ]);

    const paged: string[] = [];
    for (let offset = 0; offset < all.total; offset += 4) {
      const p = await service.findGroups(A, 'UTC', page(4, offset));
      expect(p.total).toBe(6);
      paged.push(...p.items.map(key));
    }
    expect(paged).toEqual(all.items.map(key));
  });

  it('pages one group with a stable id tiebreaker when items share a timestamp', async () => {
    const at = '2026-10-17T12:00:00.000Z';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await seed('critical_app_access', at));
    const expected = [...ids].sort().reverse();
    const key = {
      type: 'critical_app_access' as const,
      day: '2026-10-17',
      tz: 'UTC',
    };

    const seen: string[] = [];
    for (let offset = 0; offset < 5; offset += 2) {
      const p = await service.findGroupItems(A, key, page(2, offset));
      expect(p.total).toBe(5);
      seen.push(...p.items.map((n) => n.id));
    }
    expect(seen).toEqual(expected);
  });

  it('marks one group read for the caller only: not other days, types, users or invisible rows', async () => {
    const inGroup1 = await seed(
      'critical_app_access',
      '2026-10-17T08:00:00.000Z',
    );
    const inGroup2 = await seed(
      'critical_app_access',
      '2026-10-17T09:00:00.000Z',
    );
    const dismissed = await seed(
      'critical_app_access',
      '2026-10-17T10:00:00.000Z',
    );
    await seed('critical_app_access', '2026-10-16T09:00:00.000Z');
    await seed('low_stock', '2026-10-17T09:00:00.000Z');
    const forB = await seed('critical_app_access', '2026-10-17T09:30:00.000Z', {
      recipient: MEMBER_B,
    });
    await service.dismiss(A, dismissed);
    const dismissedBefore = await prisma.notificationRead.findFirstOrThrow({
      where: { userId: ADMIN_A, notificationId: dismissed },
    });
    const key = {
      type: 'critical_app_access' as const,
      day: '2026-10-17',
      tz: 'UTC',
    };

    const first = await service.markGroupRead(A, key);
    expect(first).toEqual({ marked: 2, unread: 2 });
    expect(await readsOf(ADMIN_A)).toEqual(
      [dismissed, inGroup1, inGroup2].sort(),
    );
    expect(await readsOf(ADMIN_C)).toEqual([]);
    expect(await readsOf(MEMBER_B)).toEqual([]);
    const dismissedAfter = await prisma.notificationRead.findFirstOrThrow({
      where: { userId: ADMIN_A, notificationId: dismissed },
    });
    expect(dismissedAfter).toEqual(dismissedBefore);

    expect(await service.markGroupRead(A, key)).toEqual({
      marked: 0,
      unread: 2,
    });

    // A member cannot reach broadcasts; their own targeted row in the same group is theirs to mark.
    expect(await service.markGroupRead(B, key)).toEqual({
      marked: 1,
      unread: 0,
    });
    expect(await readsOf(MEMBER_B)).toEqual([forB]);
  });

  it('keeps the unread count exact and equal to the sum of group unread counts', async () => {
    for (let i = 0; i < 120; i++) {
      await seed(
        'critical_app_access',
        `2026-10-17T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}.000Z`,
      );
    }
    const stock = await seed('low_stock', '2026-10-16T10:00:00.000Z');
    const dismissed = await seed('low_stock', '2026-10-16T11:00:00.000Z');
    const forB = await seed(
      'access_request.decided',
      '2026-10-17T10:00:00.000Z',
      {
        recipient: MEMBER_B,
      },
    );
    await service.dismiss(A, dismissed);
    await service.markRead(A, stock);

    expect(await service.unreadCount(A)).toBe(120);
    const groups = await service.findGroups(A, 'UTC', page(50));
    expect(groups.items.reduce((sum, g) => sum + g.unread, 0)).toBe(120);
    expect(groups.items.find((g) => g.type === 'low_stock')).toMatchObject({
      count: 1,
      unread: 0,
    });

    expect(await service.unreadCount(B)).toBe(1);
    const mine = await service.findGroups(B, 'UTC', page(50));
    expect(mine.items.map((g) => [g.type, g.count])).toEqual([
      ['access_request.decided', 1],
    ]);
    expect(mine.items[0].latest[0].id).toBe(forB);

    const marked = await service.markGroupRead(A, {
      type: 'critical_app_access',
      day: '2026-10-17',
      tz: 'UTC',
    });
    expect(marked).toEqual({ marked: 120, unread: 0 });
    expect(await service.unreadCount(C)).toBe(122);
  });
});
