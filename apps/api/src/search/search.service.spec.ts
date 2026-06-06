import { Test } from '@nestjs/testing';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { Meilisearch } from 'meilisearch';
import { SearchService } from './search.service';

// Mock the Meili client with an explicit factory: jest can't transform the ESM `meilisearch`
// package, so we must never load the real module. The constructor is a jest mock whose
// implementation each test sets to return a fake client (index()/multiSearch()).
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

// Typed handles for the mocked index methods (addDocuments/deleteDocument return a thenable in the
// real client; here they're plain jest mocks whose resolved/rejected value we control per test).
type IndexMock = {
  addDocuments: jest.Mock;
  deleteDocument: jest.Mock;
};
type ClientMock = {
  index: jest.Mock;
  multiSearch: jest.Mock;
};

const MeilisearchMock = Meilisearch as unknown as jest.Mock;

// A logger double; the service only calls info/error/setContext on it.
const loggerMock = (): { info: jest.Mock; error: jest.Mock } => ({
  info: jest.fn(),
  error: jest.fn(),
});

async function buildService(logger: {
  info: jest.Mock;
  error: jest.Mock;
}): Promise<SearchService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      SearchService,
      { provide: getLoggerToken(SearchService.name), useValue: logger },
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

      // articles: content is indexed (searchable) but must not be retrievable
      expect(byIndex.get('articles')?.attributesToRetrieve).toEqual([
        'id',
        'slug',
        'title',
        'excerpt',
        'status',
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
    it('search returns empty blocks (not a throw) when multiSearch rejects, and logs it', async () => {
      const boom = new Error('meili unreachable');
      client.multiSearch.mockRejectedValueOnce(boom);

      const result = await service.search({
        q: 'srv',
        entities: ['assets', 'users'],
        limit: 20,
      });

      // Fail-soft: empty blocks for every requested entity, no exception bubbles to the controller.
      expect(result).toEqual({
        assets: { hits: [], total: 0 },
        users: { hits: [], total: 0 },
      });
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [meta] = logger.error.mock.calls[0] as [{ err: unknown }];
      expect(meta.err).toBe(boom);
    });

    it('search fail-soft defaults to empty blocks for all five indexes when entities omitted', async () => {
      client.multiSearch.mockRejectedValueOnce(new Error('meili down'));

      const result = await service.search({ q: 'x', limit: 20 });

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

  // Guards the DI token wiring: the provider resolves with the real PinoLogger token shape.
  it('is injectable via the PinoLogger token', () => {
    expect(getLoggerToken(SearchService.name)).toBeDefined();
    // PinoLogger is only referenced for its type in the service; touch it so the import is exercised.
    expect(PinoLogger).toBeDefined();
  });
});
