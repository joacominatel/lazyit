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
      expect(search.rebuildIndex).toHaveBeenCalledWith('assets', [{ id: 'a1' }]);
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
      // The probe was scheduled on the microtask queue; let it run.
      await Promise.resolve();
      await Promise.resolve();

      expect(search.emptyOrMissingIndexes).toHaveBeenCalledTimes(1);
    });
  });
});
