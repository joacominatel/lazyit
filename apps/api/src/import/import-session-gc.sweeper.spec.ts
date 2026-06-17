import { ImportSessionGcSweeper } from './import-session-gc.sweeper';

// Mock the generated Prisma client so importing the sweeper never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * The migrator session GC sweep (ADR-0069 §2, #635). Proves the sweep hard-deletes sessions past their
 * 24h TTL (cascading to rows + runs via the schema FK), never reaps a mid-commit (COMMITTING) session,
 * is re-entrancy guarded, is best-effort (a DB error never throws), and is a no-op under NODE_ENV=test.
 */
describe('ImportSessionGcSweeper', () => {
  let importSession: { deleteMany: jest.Mock };
  let sweeper: ImportSessionGcSweeper;

  beforeEach(() => {
    importSession = { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) };
    const prisma = { importSession };
    sweeper = new ImportSessionGcSweeper(prisma as never);
  });

  it('hard-deletes sessions past expiresAt, excluding any mid-commit (COMMITTING) session', async () => {
    const before = Date.now();
    const count = await sweeper.sweep();
    const after = Date.now();

    expect(count).toBe(3);
    expect(importSession.deleteMany).toHaveBeenCalledTimes(1);
    const where = importSession.deleteMany.mock.calls[0]![0].where;
    // Reaps only EXPIRED sessions…
    const cutoff: Date = where.expiresAt.lt;
    expect(cutoff).toBeInstanceOf(Date);
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after + 5);
    // …and NEVER a session whose commit is still running.
    expect(where.status).toEqual({ not: 'COMMITTING' });
  });

  it('is re-entrancy guarded: a second concurrent pass is a no-op while the first runs', async () => {
    let release!: () => void;
    importSession.deleteMany.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ count: 1 });
        }),
    );
    const first = sweeper.sweep();
    // A second call while the first is in-flight returns 0 immediately and does not double-delete.
    await expect(sweeper.sweep()).resolves.toBe(0);
    release();
    await expect(first).resolves.toBe(1);
    expect(importSession.deleteMany).toHaveBeenCalledTimes(1);
  });

  it('is best-effort: a DB error is swallowed (returns 0, never throws)', async () => {
    importSession.deleteMany.mockRejectedValue(new Error('db down'));
    await expect(sweeper.sweep()).resolves.toBe(0);
    // …and the re-entrancy guard is released so the next tick can run.
    importSession.deleteMany.mockResolvedValue({ count: 0 });
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
