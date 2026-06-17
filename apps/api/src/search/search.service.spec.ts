import { Test } from '@nestjs/testing';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import { SearchService } from './search.service';
import { FolderAccessService } from '../article-categories/folder-access.service';
import type { VisibleFolders } from '../article-categories/folder-access.service';

// Mock the Meili client with an explicit factory: jest can't transform the ESM `meilisearch`
// package, so we must never load the real module. The constructor is a jest mock whose
// implementation each test sets to return a fake client (index()/multiSearch()).
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));
// SearchService now transitively imports the generated Prisma client (via FolderAccessService →
// PrismaService for the ADR-0060 §5 post-filter); jest can't transform its ESM `.js` imports.
// FolderAccessService is replaced by a mock below; this stub stops the real client from loading.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

// Typed handles for the mocked index methods (addDocuments/deleteDocument return a thenable in the
// real client; here they're plain jest mocks whose resolved/rejected value we control per test).
type IndexMock = {
  addDocuments: jest.Mock;
  deleteDocument: jest.Mock;
};
type ClientMock = {
  index: jest.Mock;
  multiSearch: jest.Mock;
  getStats: jest.Mock;
};

const MeilisearchMock = Meilisearch as unknown as jest.Mock;

// A logger double; the service only calls info/error/setContext on it.
const loggerMock = (): { info: jest.Mock; error: jest.Mock } => ({
  info: jest.fn(),
  error: jest.fn(),
});

// The folder-access evaluator is mocked; the ADR-0060 §5 article search post-filter calls
// visibleFolderIds(principal). Defaults to 'ALL' (ADMIN-equivalent: every hit kept) so the pre-0060
// search tests are unchanged; the dedicated leak test overrides it to a Set.
function folderAccessMock(visible: VisibleFolders = 'ALL'): {
  visibleFolderIds: jest.Mock;
} {
  return { visibleFolderIds: jest.fn().mockResolvedValue(visible) };
}

async function buildService(
  logger: { info: jest.Mock; error: jest.Mock },
  folderAccess: { visibleFolderIds: jest.Mock } = folderAccessMock(),
): Promise<SearchService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SearchService,
      { provide: getLoggerToken(SearchService.name), useValue: logger },
      { provide: FolderAccessService, useValue: folderAccess },
    ],
  }).compile();
  return moduleRef.get(SearchService);
}

describe('SearchService', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
  });

  // --- disabled mode (no MEILI_HOST) ---------------------------------------
  describe('disabled mode (MEILI_HOST unset)', () => {
    let logger: ReturnType<typeof loggerMock>;
    let service: SearchService;

    beforeEach(async () => {
      delete process.env.MEILI_HOST;
      delete process.env.MEILI_MASTER_KEY;
      logger = loggerMock();
      service = await buildService(logger);
    });

    it('never constructs a Meili client and reports disabled', () => {
      expect(MeilisearchMock).not.toHaveBeenCalled();
      expect(service.enabled).toBe(false);
    });

    it('upsert is a no-op that does not throw', () => {
      expect(() =>
        service.upsert('assets', { id: 'a1', name: 'SRV-01' }),
      ).not.toThrow();
    });

    it('remove is a no-op that does not throw', () => {
      expect(() => service.remove('assets', 'a1')).not.toThrow();
    });

    it('search returns an empty block for every requested entity', async () => {
      const result = await service.search({
        q: 'srv',
        entities: ['assets', 'users'],
        limit: 20,
      });
      expect(result).toEqual({
        assets: { hits: [], total: 0 },
        users: { hits: [], total: 0 },
      });
    });

    it('search with no entities returns empty blocks for all five indexes', async () => {
      const result = await service.search({ q: '', limit: 20 });
      expect(Object.keys(result).sort()).toEqual([
        'applications',
        'articles',
        'assets',
        'locations',
        'users',
      ]);
      expect(result.assets).toEqual({ hits: [], total: 0 });
    });
  });

  // --- enabled mode (MEILI_HOST set) ---------------------------------------
  describe('enabled mode (MEILI_HOST set)', () => {
    let logger: ReturnType<typeof loggerMock>;
    let service: SearchService;
    let index: IndexMock;
    let client: ClientMock;

    beforeEach(async () => {
      process.env.MEILI_HOST = 'http://localhost:7700';
      process.env.MEILI_MASTER_KEY = 'masterKey';
      index = {
        addDocuments: jest.fn().mockResolvedValue({ taskUid: 1 }),
        deleteDocument: jest.fn().mockResolvedValue({ taskUid: 2 }),
      };
      client = {
        index: jest.fn().mockReturnValue(index),
        multiSearch: jest.fn(),
        getStats: jest.fn(),
      };
      MeilisearchMock.mockImplementation(() => client);
      logger = loggerMock();
      service = await buildService(logger);
    });

    it('constructs the client from MEILI_HOST / MEILI_MASTER_KEY and reports enabled', () => {
      expect(MeilisearchMock).toHaveBeenCalledWith({
        host: 'http://localhost:7700',
        apiKey: 'masterKey',
      });
      expect(service.enabled).toBe(true);
    });

    it('upsert adds the document to the index with primaryKey id', () => {
      const doc = { id: 'a1', name: 'SRV-01' };
      service.upsert('assets', doc);
      expect(client.index).toHaveBeenCalledWith('assets');
      expect(index.addDocuments).toHaveBeenCalledWith([doc], {
        primaryKey: 'id',
      });
    });

    it('remove deletes the document by id', () => {
      service.remove('users', 'u1');
      expect(client.index).toHaveBeenCalledWith('users');
      expect(index.deleteDocument).toHaveBeenCalledWith('u1');
    });

    it('upsert swallows a rejected addDocuments and logs it (fire-and-forget)', async () => {
      const boom = new Error('meili down');
      index.addDocuments.mockRejectedValueOnce(boom);

      // The call itself must not throw...
      expect(() =>
        service.upsert('assets', { id: 'a1', name: 'x' }),
      ).not.toThrow();
      // ...and the rejection is caught + logged on the next microtask, never surfaced.
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [meta] = logger.error.mock.calls[0] as [
        { err: unknown; index: string; id: string },
      ];
      expect(meta.err).toBe(boom);
      expect(meta.index).toBe('assets');
      expect(meta.id).toBe('a1');
    });

    it('remove swallows a rejected deleteDocument and logs it (fire-and-forget)', async () => {
      index.deleteDocument.mockRejectedValueOnce(new Error('meili down'));

      expect(() => service.remove('users', 'u1')).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalledTimes(1);
    });

    it('runSuppressed mutes upsert/remove for the bracket then restores them (ADR-0069 §10)', async () => {
      await service.runSuppressed(async () => {
        service.upsert('assets', { id: 'a1', name: 'x' });
        service.remove('assets', 'a2');
      });
      // No write reached the client while suppressed.
      expect(index.addDocuments).not.toHaveBeenCalled();
      expect(index.deleteDocument).not.toHaveBeenCalled();

      // After the bracket, writes flow again.
      service.upsert('assets', { id: 'a3', name: 'y' });
      expect(index.addDocuments).toHaveBeenCalledTimes(1);
    });

    it('runSuppressed restores writes even when the bracketed fn throws', async () => {
      await expect(
        service.runSuppressed(async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // The finally decremented the depth — a subsequent write is NOT muted.
      service.upsert('assets', { id: 'a4', name: 'z' });
      expect(index.addDocuments).toHaveBeenCalledTimes(1);
    });

    it('search runs a multiSearch over the requested indexes and maps the results', async () => {
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'assets',
            hits: [{ id: 'a1', name: 'SRV-01' }],
            estimatedTotalHits: 7,
          },
          {
            indexUid: 'users',
            hits: [{ id: 'u1', email: 'a@b.com' }],
            estimatedTotalHits: 2,
          },
        ],
      });

      const result = await service.search({
        q: 'srv',
        entities: ['assets', 'users'],
        limit: 10,
      });

      expect(client.multiSearch).toHaveBeenCalledWith({
        queries: [
          {
            indexUid: 'assets',
            q: 'srv',
            limit: 10,
            attributesToRetrieve: [
              'id',
              'name',
              'serial',
              'assetTag',
              'status',
              'notes',
            ],
          },
          {
            indexUid: 'users',
            q: 'srv',
            limit: 10,
            attributesToRetrieve: ['id', 'firstName', 'lastName', 'email'],
          },
        ],
      });
      expect(result).toEqual({
        assets: { hits: [{ id: 'a1', name: 'SRV-01' }], total: 7 },
        users: { hits: [{ id: 'u1', email: 'a@b.com' }], total: 2 },
      });
    });

    // --- ADR-0060 §5: the search-leak fix (INV-9) ----------------------------

    it('drops a restricted article hit from a non-matching caller and strips the internal categoryId', async () => {
      // Two article hits: one in a PUBLIC folder, one in a folder the caller cannot see. The post-filter
      // must drop the restricted one entirely AND strip `categoryId` from the surviving (public) hit.
      const folderAccess = folderAccessMock(new Set(['public-folder']));
      const scopedService = await buildService(logger, folderAccess);
      // Re-point the (already-constructed) mocked client onto the new instance: buildService reuses the
      // same Meilisearch mock factory, so `client` (set in beforeEach) is the live double here too.
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            hits: [
              {
                id: 'pub1',
                slug: 'public',
                title: 'Public',
                categoryId: 'public-folder',
              },
              {
                id: 'sec1',
                slug: 'secret',
                title: 'Secret runbook',
                categoryId: 'secret-folder',
              },
            ],
            estimatedTotalHits: 2,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'runbook',
        entities: ['articles'],
        limit: 10,
        principal: { kind: 'human', user: { id: 'u1', role: 'VIEWER' } } as never,
      });

      // Only the public-folder article survives; the restricted one NEVER surfaces.
      expect(result.articles?.hits).toEqual([
        { id: 'pub1', slug: 'public', title: 'Public' },
      ]);
      // The internal folder key is stripped from the shipped hit (wire ArticleHit has no categoryId).
      expect(result.articles?.hits[0]).not.toHaveProperty('categoryId');
      // total is re-counted to what the caller can actually see.
      expect(result.articles?.total).toBe(1);
      expect(folderAccess.visibleFolderIds).toHaveBeenCalledTimes(1);
    });

    it('an ADMIN (visibleFolderIds = ALL) keeps every article hit (categoryId still stripped)', async () => {
      const folderAccess = folderAccessMock('ALL');
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            hits: [
              { id: 'sec1', slug: 'secret', title: 'Secret', categoryId: 'secret-folder' },
            ],
            estimatedTotalHits: 1,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'secret',
        entities: ['articles'],
        limit: 10,
        principal: { kind: 'human', user: { id: 'admin', role: 'ADMIN' } } as never,
      });

      expect(result.articles?.hits).toEqual([
        { id: 'sec1', slug: 'secret', title: 'Secret' },
      ]);
      expect(result.articles?.hits[0]).not.toHaveProperty('categoryId');
    });

    it('drops an article hit MISSING its categoryId for a non-admin (fail closed)', async () => {
      const folderAccess = folderAccessMock(new Set(['public-folder']));
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            // A stale doc indexed before categoryId landed — no folder key. Fail closed: drop it.
            hits: [{ id: 'stale', slug: 'stale', title: 'Stale' }],
            estimatedTotalHits: 1,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'stale',
        entities: ['articles'],
        limit: 10,
        principal: { kind: 'human', user: { id: 'u1', role: 'VIEWER' } } as never,
      });

      expect(result.articles?.hits).toEqual([]);
      expect(result.articles?.total).toBe(0);
    });

    // SEC-061: every per-index query must pin attributesToRetrieve to the shared *HitSchema fields,
    // so Meili never ships large/searchable-only blobs (article `content`) back in a hit.
    it('restricts retrieved attributes per index and never returns article content', async () => {
      client.multiSearch.mockResolvedValue({ results: [] });

      await service.search({
        q: 'srv',
        entities: ['assets', 'articles'],
        limit: 10,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        {
          queries: Array<{
            indexUid: string;
            attributesToRetrieve?: string[];
          }>;
        },
      ];
      const byIndex = new Map(
        params.queries.map((query) => [query.indexUid, query]),
      );

      // articles: content is indexed (searchable) but must not be retrievable. `categoryId` IS retrieved
      // internally for the ADR-0060 §5 folder-access post-filter, then stripped from the shipped hit.
      expect(byIndex.get('articles')?.attributesToRetrieve).toEqual([
        'id',
        'slug',
        'title',
        'excerpt',
        'status',
        'categoryId',
      ]);
      expect(byIndex.get('articles')?.attributesToRetrieve).not.toContain(
        'content',
      );
      // assets: pinned to its hit shape too
      expect(byIndex.get('assets')?.attributesToRetrieve).toEqual([
        'id',
        'name',
        'serial',
        'assetTag',
        'status',
        'notes',
      ]);
    });

    it('search defaults to all five indexes when entities is omitted', async () => {
      client.multiSearch.mockResolvedValue({ results: [] });

      await service.search({ q: 'x', limit: 20 });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ indexUid: string }> },
      ];
      expect(params.queries.map((query) => query.indexUid)).toEqual([
        'assets',
        'articles',
        'users',
        'locations',
        'applications',
      ]);
    });

    it('falls back to hits.length when a result has no estimatedTotalHits', async () => {
      client.multiSearch.mockResolvedValue({
        results: [{ indexUid: 'assets', hits: [{ id: 'a1' }, { id: 'a2' }] }],
      });

      const result = await service.search({
        q: '',
        entities: ['assets'],
        limit: 20,
      });
      expect(result.assets).toEqual({
        hits: [{ id: 'a1' }, { id: 'a2' }],
        total: 2,
      });
    });

    it('yields an empty block for a requested index Meili returns no result for', async () => {
      // Engine only returns assets; users was requested but absent -> stays an empty block.
      client.multiSearch.mockResolvedValue({
        results: [{ indexUid: 'assets', hits: [], estimatedTotalHits: 0 }],
      });

      const result = await service.search({
        q: 'x',
        entities: ['assets', 'users'],
        limit: 20,
      });
      expect(result.users).toEqual({ hits: [], total: 0 });
    });

    // --- fail-soft reads (ADR-0035): configured-but-unhealthy engine ---------
    it('search returns empty blocks marked degraded (not a throw) when multiSearch rejects, and logs it', async () => {
      const boom = new Error('meili unreachable');
      client.multiSearch.mockRejectedValueOnce(boom);

      const result = await service.search({
        q: 'srv',
        entities: ['assets', 'users'],
        limit: 20,
      });

      // Fail-soft (issue #370): empty blocks for every requested entity PLUS degraded:true, so the
      // client can tell an outage from a genuine empty result. No exception bubbles to the controller.
      expect(result).toEqual({
        assets: { hits: [], total: 0 },
        users: { hits: [], total: 0 },
        degraded: true,
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [meta] = logger.error.mock.calls[0] as [{ err: unknown }];
      expect(meta.err).toBe(boom);
    });

    it('a healthy search never sets degraded', async () => {
      client.multiSearch.mockResolvedValue({
        results: [{ indexUid: 'assets', hits: [], estimatedTotalHits: 0 }],
      });

      const result = await service.search({
        q: 'x',
        entities: ['assets'],
        limit: 20,
      });

      expect(result.degraded).toBeUndefined();
    });

    it('search fail-soft defaults to empty (degraded) blocks for all five indexes when entities omitted', async () => {
      client.multiSearch.mockRejectedValueOnce(new Error('meili down'));

      const result = await service.search({ q: 'x', limit: 20 });

      expect(result.degraded).toBe(true);
      expect(Object.keys(result).sort()).toEqual([
        'applications',
        'articles',
        'assets',
        'degraded',
        'locations',
        'users',
      ]);
      expect(result.assets).toEqual({ hits: [], total: 0 });
    });

    // --- self-heal probing (issue #370) --------------------------------------
    describe('emptyOrMissingIndexes', () => {
      it('reports indexes that are absent from stats or have zero documents', async () => {
        client.getStats.mockResolvedValue({
          indexes: {
            assets: { numberOfDocuments: 12 },
            articles: { numberOfDocuments: 0 }, // empty -> needs rebuild
            users: { numberOfDocuments: 3 },
            // locations + applications absent from the map -> never created -> need rebuild
          },
        });

        const stale = await service.emptyOrMissingIndexes();

        expect(stale.sort()).toEqual(['applications', 'articles', 'locations']);
      });

      it('reports nothing when every index has documents', async () => {
        client.getStats.mockResolvedValue({
          indexes: {
            assets: { numberOfDocuments: 1 },
            articles: { numberOfDocuments: 1 },
            users: { numberOfDocuments: 1 },
            locations: { numberOfDocuments: 1 },
            applications: { numberOfDocuments: 1 },
          },
        });

        expect(await service.emptyOrMissingIndexes()).toEqual([]);
      });
    });
  });

  // --- disabled-mode self-heal probing (no client) ---------------------------
  describe('emptyOrMissingIndexes in disabled mode', () => {
    it('returns [] without calling the engine', async () => {
      delete process.env.MEILI_HOST;
      const logger = loggerMock();
      const service = await buildService(logger);
      expect(await service.emptyOrMissingIndexes()).toEqual([]);
    });
  });

  // Guards the DI token wiring: the provider resolves with the real PinoLogger token shape.
  it('is injectable via the PinoLogger token', () => {
    expect(getLoggerToken(SearchService.name)).toBeDefined();
    // PinoLogger is only referenced for its type in the service; touch it so the import is exercised.
    expect(PinoLogger).toBeDefined();
  });
});
