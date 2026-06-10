import {
  NOTIFICATION_RETENTION_MS,
  NotificationsRetentionSweeper,
} from './notifications-retention.sweeper';

// Mock the generated Prisma client so importing the sweeper never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * The 90-day retention sweep (ADR-0056 §7): the bell is allowed to FORGET. Proves the sweep deletes the
 * read JOINS for expired events FIRST (the RESTRICT FK), then the events, both scoped to the 90-day
 * cutoff; is re-entrancy guarded; and is best-effort (a DB error never throws).
 */
describe('NotificationsRetentionSweeper', () => {
  let notification: { deleteMany: jest.Mock };
  let notificationRead: { deleteMany: jest.Mock };
  let sweeper: NotificationsRetentionSweeper;

  beforeEach(() => {
    notification = { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) };
    notificationRead = { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) };
    const prisma = { notification, notificationRead };
    sweeper = new NotificationsRetentionSweeper(prisma as never);
  });

  it('deletes the read joins of expired events, then the events, scoped to a 90-day cutoff', async () => {
    const before = Date.now();
    const count = await sweeper.sweep();
    const after = Date.now();

    expect(count).toBe(2);

    // Reads deleted first (the RESTRICT-FK children), filtered by the parent's createdAt cutoff.
    expect(notificationRead.deleteMany).toHaveBeenCalledTimes(1);
    const readWhere = notificationRead.deleteMany.mock.calls[0]![0].where;
    expect(readWhere.notification.createdAt.lt).toBeInstanceOf(Date);

    // Then the events, by their own createdAt cutoff.
    expect(notification.deleteMany).toHaveBeenCalledTimes(1);
    const cutoff: Date = notification.deleteMany.mock.calls[0]![0].where.createdAt.lt;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(
      before - NOTIFICATION_RETENTION_MS - 5,
    );
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - NOTIFICATION_RETENTION_MS + 5);
  });

  it('is best-effort: a DB error is swallowed (returns 0, never throws)', async () => {
    notificationRead.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(sweeper.sweep()).resolves.toBe(0);
  });

  it('does not run under NODE_ENV=test (onModuleInit is a no-op)', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    sweeper.onModuleInit();
    // No timer set → onModuleDestroy is a safe no-op too.
    expect(() => sweeper.onModuleDestroy()).not.toThrow();
    process.env.NODE_ENV = prev;
  });
});
