// Jest can't transform the ESM-only `meilisearch` package; the bootstrap service transitively imports
// it via SearchService, so stub the module out (we never construct a real client in these tests).
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

// Mock the generated Prisma client so importing PrismaService (transitively, via the bootstrap
// service) never loads the real one — Jest can't resolve its ESM `.js` re-exports and there is no DB.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));

import { SearchBootstrapService } from './search-bootstrap.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { SearchService, SearchIndex } from './search.service';

// Minimal doubles: the bootstrap only calls a few methods on each collaborator.
type SearchMock = {
  enabled: boolean;
  isHealthy: jest.Mock;
  emptyOrMissingIndexes: jest.Mock;
  rebuildIndex: jest.Mock;
};

function prismaMock() {
  return {
    asset: { findMany: jest.fn().mockResolvedValue([{ id: 'a1' }]) },
    article: {
      findMany: jest.fn().mockResolvedValue([{ id: 'ar1' }, { id: 'ar2' }]),
    },
    user: { findMany: jest.fn().mockResolvedValue([]) },
    location: { findMany: jest.fn().mockResolvedValue([]) },
    application: { findMany: jest.fn().mockResolvedValue([]) },
    infraNode: { findMany: jest.fn().mockResolvedValue([]) },
    consumable: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

function build(
  search: SearchMock,
  prisma: ReturnType<typeof prismaMock>,
): SearchBootstrapService {
  return new SearchBootstrapService(
    search as unknown as SearchService,
    prisma as unknown as PrismaService,
  );
}

describe('SearchBootstrapService', () => {
  const ORIGINAL_ENV = { ...process.env };
  let search: SearchMock;
  let prisma: ReturnType<typeof prismaMock>;

  beforeEach(() => {
    search = {
      enabled: true,
      isHealthy: jest.fn().mockResolvedValue(true),
      emptyOrMissingIndexes: jest.fn(),
      rebuildIndex: jest.fn().mockResolvedValue(undefined),
    };
    prisma = prismaMock();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
  });

  describe('selfHeal', () => {
    it('rebuilds only the empty/missing indexes, loading the live set for each', async () => {
      search.emptyOrMissingIndexes.mockResolvedValue([
        'assets',
        'articles',
      ] satisfies SearchIndex[]);

      const healed = await build(search, prisma).selfHeal();

      expect(healed).toEqual(['assets', 'articles']);
      // Only the stale indexes were rebuilt — users/locations/applications were skipped.
      expect(search.rebuildIndex).toHaveBeenCalledTimes(2);
      expect(search.rebuildIndex).toHaveBeenCalledWith('assets', [
        { id: 'a1' },
      ]);
      expect(search.rebuildIndex).toHaveBeenCalledWith('articles', [
        { id: 'ar1' },
        { id: 'ar2' },
      ]);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('only indexes PUBLISHED, non-deleted articles (draft privacy)', async () => {
      search.emptyOrMissingIndexes.mockResolvedValue([
        'articles',
      ] satisfies SearchIndex[]);

      await build(search, prisma).selfHeal();

      expect(prisma.article.findMany).toHaveBeenCalledWith({
        where: { deletedAt: null, status: 'PUBLISHED' },
      });
    });

    it('is a no-op when no index is empty/missing (safe on a populated DB)', async () => {
      search.emptyOrMissingIndexes.mockResolvedValue(
        [] satisfies SearchIndex[],
      );

      expect(await build(search, prisma).selfHeal()).toEqual([]);
      expect(search.rebuildIndex).not.toHaveBeenCalled();
      expect(prisma.asset.findMany).not.toHaveBeenCalled();
    });

    it('swallows a probe failure (never escapes the background task)', async () => {
      search.emptyOrMissingIndexes.mockRejectedValue(new Error('meili down'));

      await expect(build(search, prisma).selfHeal()).resolves.toEqual([]);
      expect(search.rebuildIndex).not.toHaveBeenCalled();
    });

    it('waits for the engine to answer /health before probing (fresh volume / start ordering, #1216)', async () => {
      // Meili is still starting: two failed health probes, then healthy.
      search.isHealthy
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      search.emptyOrMissingIndexes.mockResolvedValue([
        'assets',
      ] satisfies SearchIndex[]);

      const healed = await build(search, prisma).selfHeal({
        attempts: 5,
        intervalMs: 0,
      });

      expect(search.isHealthy).toHaveBeenCalledTimes(3);
      expect(healed).toEqual(['assets']);
      expect(search.rebuildIndex).toHaveBeenCalledWith('assets', [
        { id: 'a1' },
      ]);
    });

    it('gives up after the bounded wait without probing or rebuilding (the sweeper is the backstop)', async () => {
      search.isHealthy.mockResolvedValue(false);

      const healed = await build(search, prisma).selfHeal({
        attempts: 3,
        intervalMs: 0,
      });

      expect(healed).toEqual([]);
      expect(search.isHealthy).toHaveBeenCalledTimes(3);
      expect(search.emptyOrMissingIndexes).not.toHaveBeenCalled();
      expect(search.rebuildIndex).not.toHaveBeenCalled();
    });

    it('rebuilds every index when the engine starts on an empty data volume (server upgrade, #1216)', async () => {
      // A new volume holds no index at all → every index is "missing".
      search.emptyOrMissingIndexes.mockResolvedValue([
        'assets',
        'articles',
        'users',
        'locations',
        'applications',
        'infra',
        'consumables',
      ] satisfies SearchIndex[]);

      const healed = await build(search, prisma).selfHeal();

      expect(healed).toHaveLength(7);
      expect(search.rebuildIndex).toHaveBeenCalledTimes(7);
    });

    it('continues to the next index when one rebuild fails', async () => {
      search.emptyOrMissingIndexes.mockResolvedValue([
        'assets',
        'articles',
      ] satisfies SearchIndex[]);
      search.rebuildIndex.mockRejectedValueOnce(
        new Error('rebuild assets failed'),
      );

      await build(search, prisma).selfHeal();

      // assets failed but articles was still attempted.
      expect(search.rebuildIndex).toHaveBeenCalledWith('articles', [
        { id: 'ar1' },
        { id: 'ar2' },
      ]);
    });
  });

  describe('reconcileAll', () => {
    it('rebuilds EVERY index (not just empty/missing) — for the drift-reconcile sweeper, issue #383', async () => {
      const rebuilt = await build(search, prisma).reconcileAll();

      // Every index, regardless of current doc counts — emptyOrMissingIndexes is NOT consulted.
      expect(rebuilt).toEqual([
        'assets',
        'articles',
        'users',
        'locations',
        'applications',
        'infra',
        'consumables',
      ]);
      expect(search.emptyOrMissingIndexes).not.toHaveBeenCalled();
      expect(search.rebuildIndex).toHaveBeenCalledTimes(7);
      expect(search.rebuildIndex).toHaveBeenCalledWith('assets', [
        { id: 'a1' },
      ]);
    });

    it('continues to the next index when one rebuild fails (per-index fail-soft)', async () => {
      search.rebuildIndex.mockRejectedValueOnce(
        new Error('rebuild assets failed'),
      );

      const rebuilt = await build(search, prisma).reconcileAll();

      // assets failed but the pass still attempted (and reported) every index.
      expect(rebuilt).toEqual([
        'assets',
        'articles',
        'users',
        'locations',
        'applications',
        'infra',
        'consumables',
      ]);
      expect(search.rebuildIndex).toHaveBeenCalledTimes(7);
    });
  });

  describe('onApplicationBootstrap', () => {
    it('does not self-heal under NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      build(search, prisma).onApplicationBootstrap();
      expect(search.emptyOrMissingIndexes).not.toHaveBeenCalled();
    });

    it('does not self-heal when search is disabled', () => {
      process.env.NODE_ENV = 'development';
      search.enabled = false;
      build(search, prisma).onApplicationBootstrap();
      expect(search.emptyOrMissingIndexes).not.toHaveBeenCalled();
    });

    it('kicks off self-heal (un-awaited) when enabled outside test', async () => {
      process.env.NODE_ENV = 'development';
      search.emptyOrMissingIndexes.mockResolvedValue(
        [] satisfies SearchIndex[],
      );

      build(search, prisma).onApplicationBootstrap();
      // The health wait + probe run in the background; let the queued work drain.
      await new Promise((resolve) => setImmediate(resolve));

      expect(search.emptyOrMissingIndexes).toHaveBeenCalledTimes(1);
    });
  });
});
