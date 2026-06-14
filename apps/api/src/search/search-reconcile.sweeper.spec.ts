// The sweeper transitively imports `meilisearch` (ESM-only, Jest can't transform it) and the generated
// Prisma client (ESM `.js` re-exports Jest can't resolve, and there is no DB) via SearchBootstrapService
// → SearchService / PrismaService. Stub both — these unit tests construct neither a real client nor a DB.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));

import {
  SearchReconcileSweeper,
  SEARCH_RECONCILE_DEFAULT_INTERVAL_MS,
  resolveReconcileIntervalMs,
} from './search-reconcile.sweeper';
import type { SearchBootstrapService } from './search-bootstrap.service';
import type { SearchService, SearchIndex } from './search.service';

const ALL_INDEXES: SearchIndex[] = [
  'assets',
  'articles',
  'users',
  'locations',
  'applications',
];

// Minimal doubles: the sweeper only touches `bootstrap.reconcileAll()` and `search.enabled`. Mocking
// them keeps the test light — NO real Meili/Postgres is spun up (other agents may share this machine).
type BootstrapMock = { reconcileAll: jest.Mock };
type SearchMock = { enabled: boolean };

function build(
  bootstrap: BootstrapMock,
  search: SearchMock,
): SearchReconcileSweeper {
  return new SearchReconcileSweeper(
    bootstrap as unknown as SearchBootstrapService,
    search as unknown as SearchService,
  );
}

/**
 * The periodic drift-reconcile sweeper (issue #383, ADR-0035 amendment 2026-06-14). Proves it schedules
 * on the configured interval, delegates each pass to the bootstrap service's `reconcileAll` (reusing the
 * existing reindex seam — it never re-implements reindex), swallows errors fail-soft, is re-entrancy
 * guarded, and `unref`'s / clears its interval on shutdown.
 */
describe('SearchReconcileSweeper', () => {
  const ORIGINAL_ENV = { ...process.env };
  let bootstrap: BootstrapMock;
  let search: SearchMock;

  beforeEach(() => {
    jest.useFakeTimers();
    bootstrap = { reconcileAll: jest.fn().mockResolvedValue(ALL_INDEXES) };
    search = { enabled: true };
    // Default to a non-test, search-enabled environment so onModuleInit actually arms the timer.
    process.env.NODE_ENV = 'development';
    delete process.env.SEARCH_RECONCILE_INTERVAL_MS;
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
  });

  describe('resolveReconcileIntervalMs', () => {
    it('uses SEARCH_RECONCILE_INTERVAL_MS when a positive number', () => {
      expect(resolveReconcileIntervalMs('120000')).toBe(120000);
    });

    it('falls back to the hourly default on unset / non-numeric / non-positive', () => {
      expect(resolveReconcileIntervalMs(undefined)).toBe(
        SEARCH_RECONCILE_DEFAULT_INTERVAL_MS,
      );
      expect(resolveReconcileIntervalMs('nonsense')).toBe(
        SEARCH_RECONCILE_DEFAULT_INTERVAL_MS,
      );
      expect(resolveReconcileIntervalMs('0')).toBe(
        SEARCH_RECONCILE_DEFAULT_INTERVAL_MS,
      );
      expect(resolveReconcileIntervalMs('-5')).toBe(
        SEARCH_RECONCILE_DEFAULT_INTERVAL_MS,
      );
    });

    it('defaults to one hour', () => {
      expect(SEARCH_RECONCILE_DEFAULT_INTERVAL_MS).toBe(60 * 60 * 1000);
    });
  });

  describe('onModuleInit scheduling', () => {
    it("arms a setInterval on the CONFIGURED interval and unref's it", () => {
      process.env.SEARCH_RECONCILE_INTERVAL_MS = '120000';

      // Return a fake timer handle whose `unref` is a spy so we can prove onModuleInit unref'd it (so
      // the sweep never holds the process open — mirrors the notifications retention sweeper).
      const unref = jest.fn();
      const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>;
      const setIntervalSpy = jest
        .spyOn(global, 'setInterval')
        .mockReturnValue(fakeTimer);

      const sweeper = build(bootstrap, search);
      sweeper.onModuleInit();

      // Scheduled exactly once, on the env-configured cadence.
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      expect(setIntervalSpy.mock.calls[0][1]).toBe(120000);
      // The returned timer was unref'd so it never holds the process open.
      expect(unref).toHaveBeenCalledTimes(1);

      sweeper.onModuleDestroy();
    });

    it('runs reconcile once per elapsed interval (delegating to reconcileAll)', async () => {
      const sweeper = build(bootstrap, search);
      sweeper.onModuleInit();

      // Nothing has fired yet — the first pass is after one full interval.
      expect(bootstrap.reconcileAll).not.toHaveBeenCalled();

      jest.advanceTimersByTime(SEARCH_RECONCILE_DEFAULT_INTERVAL_MS);
      await Promise.resolve();
      expect(bootstrap.reconcileAll).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(SEARCH_RECONCILE_DEFAULT_INTERVAL_MS);
      await Promise.resolve();
      expect(bootstrap.reconcileAll).toHaveBeenCalledTimes(2);

      sweeper.onModuleDestroy();
    });

    it('does NOT arm the timer under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const sweeper = build(bootstrap, search);
      sweeper.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
      // onModuleDestroy is a safe no-op when nothing was armed.
      expect(() => sweeper.onModuleDestroy()).not.toThrow();
    });

    it('does NOT arm the timer when search is disabled (no MEILI_HOST)', () => {
      search.enabled = false;
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      const sweeper = build(bootstrap, search);
      sweeper.onModuleInit();

      expect(setIntervalSpy).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('clears the interval so no further passes fire after shutdown', async () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval');
      const sweeper = build(bootstrap, search);
      sweeper.onModuleInit();

      sweeper.onModuleDestroy();
      expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

      // After destroy, advancing time triggers no more reconcile passes.
      jest.advanceTimersByTime(SEARCH_RECONCILE_DEFAULT_INTERVAL_MS * 3);
      await Promise.resolve();
      expect(bootstrap.reconcileAll).not.toHaveBeenCalled();
    });
  });

  describe('reconcile pass', () => {
    it('delegates the rebuild to bootstrap.reconcileAll (reuses the reindex seam, never re-implements it)', async () => {
      const sweeper = build(bootstrap, search);
      await sweeper.reconcile();
      expect(bootstrap.reconcileAll).toHaveBeenCalledTimes(1);
    });

    it('is fail-soft: a reconcile error is swallowed (never throws / crashes the API)', async () => {
      bootstrap.reconcileAll.mockRejectedValue(new Error('meili down'));
      const sweeper = build(bootstrap, search);
      await expect(sweeper.reconcile()).resolves.toBeUndefined();
    });

    it('is re-entrancy guarded: a second pass while one is in flight is skipped', async () => {
      let release: () => void = () => undefined;
      bootstrap.reconcileAll.mockReturnValue(
        new Promise<SearchIndex[]>((resolve) => {
          release = () => resolve(ALL_INDEXES);
        }),
      );
      const sweeper = build(bootstrap, search);

      const first = sweeper.reconcile(); // starts, holds `running`
      const second = sweeper.reconcile(); // should no-op while the first is in flight
      await second;
      expect(bootstrap.reconcileAll).toHaveBeenCalledTimes(1);

      release();
      await first;

      // Once the first pass finished, a fresh pass runs again (guard released).
      await sweeper.reconcile();
      expect(bootstrap.reconcileAll).toHaveBeenCalledTimes(2);
    });
  });
});
