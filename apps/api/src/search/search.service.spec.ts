import { Test } from '@nestjs/testing';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import { SearchService } from './search.service';
import { FolderAccessService } from '../article-categories/folder-access.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
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
  isHealthy: jest.Mock;
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

// The purchase-index gate (#1499): `principalHas` grants `purchaseOrder:read` unless a test revokes it.
const permissionsMock = {
  principalHas: jest.fn(),
};

// The article-hit `updatedAt` enrichment (#1539) reads live rows through Prisma. Defaults to no rows (so
// no hit gains `updatedAt` and the pre-#1539 expectations hold); the enrichment tests wire real rows.
const prismaMock = {
  article: { findMany: jest.fn() },
};

async function buildService(
  logger: { info: jest.Mock; error: jest.Mock },
  folderAccess: { visibleFolderIds: jest.Mock } = folderAccessMock(),
): Promise<SearchService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SearchService,
      { provide: getLoggerToken(SearchService.name), useValue: logger },
      { provide: FolderAccessService, useValue: folderAccess },
      { provide: PermissionResolverService, useValue: permissionsMock },
      { provide: PrismaService, useValue: prismaMock },
    ],
  }).compile();
  return moduleRef.get(SearchService);
}

describe('SearchService', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    permissionsMock.principalHas.mockResolvedValue(true);
    prismaMock.article.findMany.mockResolvedValue([]);
  });

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

    it('search with no entities returns empty blocks for every index', async () => {
      const result = await service.search({ q: '', limit: 20 });
      expect(Object.keys(result).sort()).toEqual([
        'applications',
        'articles',
        'assets',
        'consumables',
        'infra',
        'locations',
        'purchases',
        'suppliers',
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
        isHealthy: jest.fn(),
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

    it('has NO process-wide write suppression — every write reaches the client (ADR-0069 §10)', () => {
      // The migrator bulk commit used to flip a global suppressDepth, silently dropping EVERY
      // concurrent non-import write. That global is retired: suppression is now scoped to the
      // import's own asset writes via AssetsService.create({ suppressSearch }). So a concurrent
      // article/user/location upsert is always indexed — nothing is ever globally muted.
      service.upsert('users', { id: 'u1', name: 'x' });
      service.upsert('articles', { id: 'art1', name: 'y' });
      expect(index.addDocuments).toHaveBeenCalledTimes(2);
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

    it('drops a restricted article hit from a non-matching caller and keeps categoryId on the survivor (#1539)', async () => {
      // Two article hits: one in a PUBLIC folder, one in a folder the caller cannot see. The post-filter
      // must drop the restricted one entirely; the surviving (public) hit keeps its readable home folder.
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
        principal: {
          kind: 'human',
          user: { id: 'u1', role: 'VIEWER' },
        } as never,
      });

      // Only the public-folder article survives; the restricted one NEVER surfaces — not its title, not
      // its folder. The survivor ships its home folder, which the caller can read (#1539).
      expect(result.articles?.hits).toEqual([
        {
          id: 'pub1',
          slug: 'public',
          title: 'Public',
          categoryId: 'public-folder',
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('secret-folder');
      expect(JSON.stringify(result)).not.toContain('sec1');
      // total reflects the engine's filtered count minus what the backstop dropped (2 - 1).
      expect(result.articles?.total).toBe(1);
      // Resolved exactly ONCE per search: the SAME visible set feeds the Meili filter AND the backstop.
      expect(folderAccess.visibleFolderIds).toHaveBeenCalledTimes(1);
    });

    // --- #598: Meili-SIDE folder filter (readable hits below the limit window are no longer dropped) ---

    it('pushes a categoryId IN filter into the article query for a non-admin (and only articles)', async () => {
      const folderAccess = folderAccessMock(new Set(['f1', 'f2']));
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({ results: [] });

      await scopedService.search({
        q: 'x',
        entities: ['articles', 'assets'],
        limit: 10,
        principal: {
          kind: 'human',
          user: { id: 'u1', role: 'VIEWER' },
        } as never,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ indexUid: string; filter?: string }> },
      ];
      const byIndex = new Map(params.queries.map((q) => [q.indexUid, q]));
      // The article query carries the Meili-side folder scope...
      expect(byIndex.get('articles')?.filter).toBe(
        "categoryId IN ['f1', 'f2']",
      );
      // ...and no other index does (folder access is article-only).
      expect(byIndex.get('assets')?.filter).toBeUndefined();
    });

    it('an ADMIN omits the article filter entirely (sees everything, §5)', async () => {
      const folderAccess = folderAccessMock('ALL');
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({ results: [] });

      await scopedService.search({
        q: 'x',
        entities: ['articles'],
        limit: 10,
        principal: {
          kind: 'human',
          user: { id: 'admin', role: 'ADMIN' },
        } as never,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ indexUid: string; filter?: string }> },
      ];
      expect(params.queries[0].filter).toBeUndefined();
    });

    it('a caller with NO visible folders gets a never-match filter (fail closed, zero hits)', async () => {
      const folderAccess = folderAccessMock(new Set<string>());
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({ results: [] });

      await scopedService.search({
        q: 'x',
        entities: ['articles'],
        limit: 10,
        principal: {
          kind: 'human',
          user: { id: 'u1', role: 'VIEWER' },
        } as never,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ filter?: string }> },
      ];
      // `categoryId IN []` is invalid in Meili; a contradiction matches no document instead.
      expect(params.queries[0].filter).toBe(
        'categoryId IS NULL AND categoryId IS NOT NULL',
      );
    });

    it('returns a readable hit that ranks BELOW the naive limit window because the filter is applied Meili-side (#598)', async () => {
      // The regression: K restricted articles rank above L readable ones, limit < K. Pre-fix, the naive
      // query fetched `limit` raw hits (all restricted) then post-dropped them → the readable ones, which
      // ranked below `limit` and were NEVER fetched, were silently lost. With the Meili-side filter the
      // engine returns only readable docs within `limit`, so the readable hit surfaces. We simulate the
      // engine HONOURING the filter: the restricted docs are absent from the response.
      const folderAccess = folderAccessMock(new Set(['readable-folder']));
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            // Only the readable doc comes back — the restricted ones were excluded by the filter, so
            // the readable hit is no longer crowded out of the `limit` window.
            hits: [
              {
                id: 'readable1',
                slug: 'readable',
                title: 'Readable runbook',
                categoryId: 'readable-folder',
              },
            ],
            // The engine's estimatedTotalHits is the count of FILTERED (readable) matches (#598).
            estimatedTotalHits: 1,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'runbook',
        entities: ['articles'],
        limit: 2,
        principal: {
          kind: 'human',
          user: { id: 'u1', role: 'VIEWER' },
        } as never,
      });

      // The readable article is returned (it would have been dropped by the old post-filter-only path).
      expect(result.articles?.hits).toEqual([
        {
          id: 'readable1',
          slug: 'readable',
          title: 'Readable runbook',
          categoryId: 'readable-folder',
        },
      ]);
      // total reflects the engine's count of readable matches, not the kept page size by coincidence.
      expect(result.articles?.total).toBe(1);
    });

    it('an ADMIN (visibleFolderIds = ALL) keeps every article hit, with its categoryId (#1539)', async () => {
      const folderAccess = folderAccessMock('ALL');
      const scopedService = await buildService(logger, folderAccess);
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            hits: [
              {
                id: 'sec1',
                slug: 'secret',
                title: 'Secret',
                categoryId: 'secret-folder',
              },
            ],
            estimatedTotalHits: 1,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'secret',
        entities: ['articles'],
        limit: 10,
        principal: {
          kind: 'human',
          user: { id: 'admin', role: 'ADMIN' },
        } as never,
      });

      expect(result.articles?.hits).toEqual([
        {
          id: 'sec1',
          slug: 'secret',
          title: 'Secret',
          categoryId: 'secret-folder',
        },
      ]);
    });

    it('an ADMIN keeps a hit MISSING its categoryId, shipped without the field (#1539)', async () => {
      const scopedService = await buildService(logger, folderAccessMock('ALL'));
      client.multiSearch.mockResolvedValue({
        results: [
          {
            indexUid: 'articles',
            hits: [
              { id: 'stale', slug: 'stale', title: 'Stale' },
              { id: 'odd', slug: 'odd', title: 'Odd', categoryId: null },
            ],
            estimatedTotalHits: 2,
          },
        ],
      });

      const result = await scopedService.search({
        q: 'stale',
        entities: ['articles'],
        limit: 10,
      });

      // Only a string folder id ever ships; a missing or non-string value stays out of the hit.
      expect(result.articles?.hits).toEqual([
        { id: 'stale', slug: 'stale', title: 'Stale' },
        { id: 'odd', slug: 'odd', title: 'Odd' },
      ]);
    });

    // --- #1539: article hits carry their live updatedAt (read from the DB, not the index) -----------

    describe('article hit updatedAt enrichment (#1539)', () => {
      const VIEWER = {
        kind: 'human',
        user: { id: 'u1', role: 'VIEWER' },
      } as never;
      const articleHits = (
        hits: Array<Record<string, unknown>>,
        estimatedTotalHits = hits.length,
      ) => ({
        results: [{ indexUid: 'articles', hits, estimatedTotalHits }],
      });

      it('stamps each surviving hit with its live updatedAt from ONE id-IN query over live rows', async () => {
        const scoped = await buildService(
          logger,
          folderAccessMock(new Set(['f1'])),
        );
        client.multiSearch.mockResolvedValue(
          articleHits([
            { id: 'a1', title: 'One', categoryId: 'f1' },
            { id: 'a2', title: 'Two', categoryId: 'f1' },
            { id: 'hidden', title: 'Hidden', categoryId: 'f-secret' },
          ]),
        );
        prismaMock.article.findMany.mockResolvedValue([
          { id: 'a2', updatedAt: new Date('2026-10-01T12:00:00.000Z') },
          { id: 'a1', updatedAt: new Date('2026-09-30T08:30:00.000Z') },
        ]);

        const result = await scoped.search({
          q: 'x',
          entities: ['articles'],
          limit: 10,
          principal: VIEWER,
        });

        expect(result.articles?.hits).toEqual([
          {
            id: 'a1',
            title: 'One',
            categoryId: 'f1',
            updatedAt: '2026-09-30T08:30:00.000Z',
          },
          {
            id: 'a2',
            title: 'Two',
            categoryId: 'f1',
            updatedAt: '2026-10-01T12:00:00.000Z',
          },
        ]);
        expect(result.articles?.total).toBe(2);
        // One query, only for the hits that SURVIVED the folder backstop (never the dropped one).
        expect(prismaMock.article.findMany).toHaveBeenCalledTimes(1);
        expect(prismaMock.article.findMany).toHaveBeenCalledWith({
          where: { id: { in: ['a1', 'a2'] }, deletedAt: null },
          select: { id: true, updatedAt: true },
        });
      });

      it('a hit with no live row ships without updatedAt — the set of hits is unchanged', async () => {
        client.multiSearch.mockResolvedValue(
          articleHits([
            { id: 'live', title: 'Live', categoryId: 'f1' },
            { id: 'gone', title: 'Gone', categoryId: 'f1' },
          ]),
        );
        prismaMock.article.findMany.mockResolvedValue([
          { id: 'live', updatedAt: new Date('2026-10-02T00:00:00.000Z') },
        ]);

        const result = await service.search({
          q: 'x',
          entities: ['articles'],
          limit: 10,
        });

        expect(result.articles?.hits).toEqual([
          {
            id: 'live',
            title: 'Live',
            categoryId: 'f1',
            updatedAt: '2026-10-02T00:00:00.000Z',
          },
          { id: 'gone', title: 'Gone', categoryId: 'f1' },
        ]);
        expect(result.articles?.total).toBe(2);
      });

      it('survives an enrichment failure: hits ship without updatedAt, not degraded, error logged', async () => {
        client.multiSearch.mockResolvedValue(
          articleHits([{ id: 'a1', title: 'One', categoryId: 'f1' }]),
        );
        const boom = new Error('db down');
        prismaMock.article.findMany.mockRejectedValue(boom);

        const result = await service.search({
          q: 'x',
          entities: ['articles'],
          limit: 10,
        });

        expect(result.degraded).toBeUndefined();
        expect(result.articles).toEqual({
          hits: [{ id: 'a1', title: 'One', categoryId: 'f1' }],
          total: 1,
        });
        expect(logger.error).toHaveBeenCalledTimes(1);
        const [meta] = logger.error.mock.calls[0] as [{ err: unknown }];
        expect(meta.err).toBe(boom);
      });

      it('runs no query when the articles block has no hits', async () => {
        client.multiSearch.mockResolvedValue(articleHits([], 0));

        await service.search({ q: 'x', entities: ['articles'], limit: 10 });

        expect(prismaMock.article.findMany).not.toHaveBeenCalled();
      });

      it('runs no query when every hit was dropped by the folder backstop', async () => {
        const scoped = await buildService(
          logger,
          folderAccessMock(new Set(['f1'])),
        );
        client.multiSearch.mockResolvedValue(
          articleHits([{ id: 'hidden', title: 'Hidden', categoryId: 'f2' }]),
        );

        const result = await scoped.search({
          q: 'x',
          entities: ['articles'],
          limit: 10,
          principal: VIEWER,
        });

        expect(result.articles).toEqual({ hits: [], total: 0 });
        expect(prismaMock.article.findMany).not.toHaveBeenCalled();
      });

      it('runs no query when articles are not requested', async () => {
        client.multiSearch.mockResolvedValue({
          results: [
            {
              indexUid: 'assets',
              hits: [{ id: 'as1' }],
              estimatedTotalHits: 1,
            },
          ],
        });

        await service.search({ q: 'x', entities: ['assets'], limit: 10 });

        expect(prismaMock.article.findMany).not.toHaveBeenCalled();
      });

      it('the degraded path is unchanged: a failed multiSearch never reaches the enrichment', async () => {
        client.multiSearch.mockRejectedValueOnce(new Error('meili down'));

        const result = await service.search({
          q: 'x',
          entities: ['articles'],
          limit: 10,
        });

        expect(result).toEqual({
          articles: { hits: [], total: 0 },
          degraded: true,
        });
        expect(prismaMock.article.findMany).not.toHaveBeenCalled();
      });
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
        principal: {
          kind: 'human',
          user: { id: 'u1', role: 'VIEWER' },
        } as never,
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

    it('purchase and supplier hits carry display fields only — never line descriptions or contact names (#1499, SEC-061)', async () => {
      client.multiSearch.mockResolvedValue({ results: [] });

      await service.search({
        q: 'thinkpad',
        entities: ['purchases', 'suppliers'],
        limit: 10,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        {
          queries: Array<{ indexUid: string; attributesToRetrieve?: string[] }>;
        },
      ];
      const byIndex = new Map(
        params.queries.map((query) => [query.indexUid, query]),
      );
      expect(byIndex.get('purchases')?.attributesToRetrieve).toEqual([
        'id',
        'reference',
        'supplierName',
        'invoiceNumbers',
        'status',
        'orderDate',
        'createdAt',
      ]);
      expect(byIndex.get('suppliers')?.attributesToRetrieve).toEqual([
        'id',
        'name',
        'taxId',
      ]);
    });

    it('drops the purchase indexes itself for a principal without purchaseOrder:read — defense in depth behind the controller (#1499)', async () => {
      permissionsMock.principalHas.mockResolvedValue(false);
      client.multiSearch.mockResolvedValue({ results: [] });
      const viewer = { kind: 'human', user: { role: 'VIEWER' } } as never;

      const all = await service.search({ q: 'x', limit: 5, principal: viewer });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ indexUid: string }> },
      ];
      const queried = params.queries.map((query) => query.indexUid);
      expect(queried).not.toContain('purchases');
      expect(queried).not.toContain('suppliers');
      expect(all).not.toHaveProperty('purchases');
      expect(permissionsMock.principalHas).toHaveBeenCalledWith(
        viewer,
        'purchaseOrder:read',
      );

      // Asking ONLY for them yields nothing at all — never re-expanded to "every index".
      client.multiSearch.mockClear();
      const only = await service.search({
        q: 'x',
        entities: ['purchases', 'suppliers'],
        limit: 5,
        principal: viewer,
      });
      expect(only).toEqual({});
      expect(client.multiSearch).not.toHaveBeenCalled();
    });

    it('fails closed for a call with no principal at all', async () => {
      permissionsMock.principalHas.mockImplementation((principal: unknown) =>
        Promise.resolve(principal !== undefined),
      );
      client.multiSearch.mockResolvedValue({ results: [] });

      await service.search({
        q: 'x',
        entities: ['purchases', 'assets'],
        limit: 5,
      });

      const [params] = client.multiSearch.mock.calls[0] as [
        { queries: Array<{ indexUid: string }> },
      ];
      expect(params.queries.map((query) => query.indexUid)).toEqual(['assets']);
    });

    it('upsertMany writes every document in one engine task, and skips an empty batch', () => {
      const docs = [{ id: 'po1' }, { id: 'po2' }];
      service.upsertMany('purchases', docs);
      service.upsertMany('purchases', []);
      expect(index.addDocuments).toHaveBeenCalledTimes(1);
      expect(index.addDocuments).toHaveBeenCalledWith(docs, {
        primaryKey: 'id',
      });
    });

    it('upsertMany swallows a rejected addDocuments and logs every id (fire-and-forget)', async () => {
      index.addDocuments.mockRejectedValueOnce(new Error('meili down'));

      expect(() =>
        service.upsertMany('purchases', [{ id: 'po1' }, { id: 'po2' }]),
      ).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      const [meta] = logger.error.mock.calls[0] as [{ ids: string[] }];
      expect(meta.ids).toEqual(['po1', 'po2']);
    });

    it('search defaults to every index when entities is omitted', async () => {
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
        'infra',
        'consumables',
        'purchases',
        'suppliers',
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

    it('search fail-soft defaults to empty (degraded) blocks for every index when entities omitted', async () => {
      client.multiSearch.mockRejectedValueOnce(new Error('meili down'));

      const result = await service.search({ q: 'x', limit: 20 });

      expect(result.degraded).toBe(true);
      expect(Object.keys(result).sort()).toEqual([
        'applications',
        'articles',
        'assets',
        'consumables',
        'degraded',
        'infra',
        'locations',
        'purchases',
        'suppliers',
        'users',
      ]);
      expect(result.assets).toEqual({ hits: [], total: 0 });
    });

    // --- engine health (issue #1216) ------------------------------------------
    describe('isHealthy', () => {
      it('reports the client health check', async () => {
        client.isHealthy.mockResolvedValue(true);
        expect(await service.isHealthy()).toBe(true);
        client.isHealthy.mockResolvedValue(false);
        expect(await service.isHealthy()).toBe(false);
      });

      it('never throws: a transport error reads as unhealthy', async () => {
        client.isHealthy.mockRejectedValue(new Error('ECONNREFUSED'));
        expect(await service.isHealthy()).toBe(false);
      });
    });

    // --- self-heal probing (issue #370) --------------------------------------
    describe('emptyOrMissingIndexes', () => {
      it('reports indexes that are absent from stats or have zero documents', async () => {
        client.getStats.mockResolvedValue({
          indexes: {
            assets: { numberOfDocuments: 12 },
            articles: { numberOfDocuments: 0 }, // empty -> needs rebuild
            users: { numberOfDocuments: 3 },
            infra: { numberOfDocuments: 4 },
            // locations + applications + consumables + purchases + suppliers absent -> never created -> rebuild
          },
        });

        const stale = await service.emptyOrMissingIndexes();

        expect(stale.sort()).toEqual([
          'applications',
          'articles',
          'consumables',
          'locations',
          'purchases',
          'suppliers',
        ]);
      });

      it('reports nothing when every index has documents', async () => {
        client.getStats.mockResolvedValue({
          indexes: {
            assets: { numberOfDocuments: 1 },
            articles: { numberOfDocuments: 1 },
            users: { numberOfDocuments: 1 },
            locations: { numberOfDocuments: 1 },
            applications: { numberOfDocuments: 1 },
            infra: { numberOfDocuments: 1 },
            consumables: { numberOfDocuments: 1 },
            purchases: { numberOfDocuments: 1 },
            suppliers: { numberOfDocuments: 1 },
          },
        });

        expect(await service.emptyOrMissingIndexes()).toEqual([]);
      });

      it('after an upgrade, reports exactly the two new purchase indexes (#1499) — the boot self-heal builds them', async () => {
        // An instance that ran the previous release: the seven older indexes are populated.
        client.getStats.mockResolvedValue({
          indexes: {
            assets: { numberOfDocuments: 1 },
            articles: { numberOfDocuments: 1 },
            users: { numberOfDocuments: 1 },
            locations: { numberOfDocuments: 1 },
            applications: { numberOfDocuments: 1 },
            infra: { numberOfDocuments: 1 },
            consumables: { numberOfDocuments: 1 },
          },
        });

        expect(await service.emptyOrMissingIndexes()).toEqual([
          'purchases',
          'suppliers',
        ]);
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

    it('isHealthy is false without calling the engine', async () => {
      delete process.env.MEILI_HOST;
      const logger = loggerMock();
      const service = await buildService(logger);
      expect(await service.isHealthy()).toBe(false);
    });
  });

  // Guards the DI token wiring: the provider resolves with the real PinoLogger token shape.
  it('is injectable via the PinoLogger token', () => {
    expect(getLoggerToken(SearchService.name)).toBeDefined();
    // PinoLogger is only referenced for its type in the service; touch it so the import is exercised.
    expect(PinoLogger).toBeDefined();
  });
});
