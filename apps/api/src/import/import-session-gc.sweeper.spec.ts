import { ImportSessionGcSweeper } from './import-session-gc.sweeper';

// Mock the generated Prisma client so importing the sweeper never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

/**
 * The migrator session GC sweep (ADR-0069 §2, #635). Proves the sweep hard-deletes sessions past their
 * 24h TTL (cascading ONLY to `ImportRow`s via the schema FK — the `ImportRun` ledger is NOT cascaded and
 * the sweeper never touches it: ADR-0069 §9 / ADR-0006 append-only), never reaps a mid-commit
 * (COMMITTING) session, is re-entrancy guarded, is best-effort (a DB error never throws), and is a no-op
 * under NODE_ENV=test.
 */
describe('ImportSessionGcSweeper', () => {
  let importSession: { deleteMany: jest.Mock };
  let importRun: { deleteMany: jest.Mock };
  let sweeper: ImportSessionGcSweeper;

  beforeEach(() => {
    importSession = { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) };
    // Present on the mock only to PROVE the sweeper never calls it (the ledger must survive GC).
    importRun = { deleteMany: jest.fn() };
    const prisma = { importSession, importRun };
    sweeper = new ImportSessionGcSweeper(prisma as never);
  });

  it('NEVER deletes ImportRun ledger rows — the append-only audit-of-record survives session GC (ADR-0069 §9)', async () => {
    await sweeper.sweep();
    expect(importSession.deleteMany).toHaveBeenCalledTimes(1);
    // The ledger is correlated by a durable plain `sessionId` (NOT a cascading FK), so reaping a session
    // can never reap its run. The sweeper must touch ONLY ImportSession (its rows cascade); the run stays.
    expect(importRun.deleteMany).not.toHaveBeenCalled();
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
