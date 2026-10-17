/**
 * Search WIRE test (#1216, ADR-0035 amendment 2026-09-26) — real HTTP round-trips against the PINNED
 * Meilisearch server image, with the real `meilisearch` client.
 *
 * Every other search spec mocks the client, so a client/server incompatibility (a renamed field, a
 * rejected parameter, a filter-syntax change) would pass the whole unit suite and surface only as an
 * operator's empty search results. This suite exercises the exact code paths production uses:
 *
 *  - the boot self-heal on a FRESH, EMPTY engine (what every instance sees right after a server upgrade,
 *    which starts Meili on a new data volume) — health wait → stats probe → full rebuild of every index;
 *  - `reindexIndex` (create, filterable-attribute settings, batched adds, `swapIndexes`, temp cleanup)
 *    with our real document shapes (the `search.documents.ts` projectors);
 *  - `SearchService.search` (`multiSearch`, `attributesToRetrieve`, the article folder filter — including
 *    the fail-closed never-match expression, which must stay valid syntax on the pinned server);
 *  - the fire-and-forget `upsert` / `remove` sync.
 *
 * NOT part of the default unit run: the default jest config's rootDir is `src/`, and this file lives in
 * `test/` and is matched only by `test/jest-wire.json` (`bun run test:wire`). It needs a reachable
 * engine: MEILI_HOST + MEILI_MASTER_KEY (CI's search-wire job starts the meilisearch service from
 * compose.yaml, i.e. the pinned image). It FAILS — never silently skips — when they are missing, so the CI job cannot go
 * green without having made a wire call.
 *
 * It drops and recreates every lazyit index: point it only at a throwaway engine.
 */
import { Meilisearch } from 'meilisearch';
import type { PinoLogger } from 'nestjs-pino';

// SearchService → FolderAccessService → PrismaService imports the generated Prisma client, whose ESM
// `.js` re-exports jest cannot load. No database is involved here: stub it (as the unit specs do).
jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { defineExtension: (x: unknown) => x },
}));

import { SearchService, SEARCH_INDEXES } from '../src/search/search.service';
import { SearchBootstrapService } from '../src/search/search-bootstrap.service';
import { reindexIndex } from '../src/search/reindex';
import {
  projectApplication,
  projectArticle,
  projectAsset,
  projectConsumable,
  projectInfraNode,
  projectLocation,
  projectPurchaseOrder,
  projectSupplier,
  projectUser,
} from '../src/search/search.documents';
import type {
  FolderAccessService,
  VisibleFolders,
} from '../src/article-categories/folder-access.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { PermissionResolverService } from '../src/auth/permission-resolver.service';

const HOST = process.env.MEILI_HOST;
const KEY = process.env.MEILI_MASTER_KEY;

// Waiting on real engine tasks; generous for a cold CI runner.
jest.setTimeout(60_000);

// --- fixture rows, shaped exactly like the Prisma rows the projectors take -----------------------
const ASSETS = [
  {
    id: 'asset-1',
    name: 'Dell Latitude 7440',
    serial: 'SN-ALPHA-001',
    assetTag: 'IT-0001',
    status: 'IN_USE',
    notes: null,
  },
  {
    id: 'asset-2',
    name: 'Cisco Catalyst switch',
    serial: null,
    assetTag: 'IT-0002',
    status: 'IN_STOCK',
    notes: 'rack B',
  },
];
const ARTICLES = [
  {
    id: 'art-public',
    slug: 'vpn-setup',
    title: 'VPN setup runbook',
    excerpt: 'How to connect',
    status: 'PUBLISHED',
    content: 'Install the wireguard client and import the profile.',
    categoryId: 'folder-public',
    updatedAt: new Date('2026-09-20T10:00:00.000Z'),
  },
  {
    id: 'art-restricted',
    slug: 'vpn-admin',
    title: 'VPN admin runbook',
    excerpt: null,
    status: 'PUBLISHED',
    content: 'Rotate the wireguard server keys quarterly.',
    categoryId: 'folder-restricted',
    updatedAt: new Date('2026-09-21T10:00:00.000Z'),
  },
];
const USERS = [
  {
    id: 'user-1',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.test',
  },
];
const LOCATIONS = [
  {
    id: 'loc-1',
    name: 'HQ Server Room',
    type: 'ROOM',
    address: null,
    floor: '2',
  },
];
const APPLICATIONS = [
  {
    id: 'app-1',
    name: 'Grafana',
    vendor: 'Grafana Labs',
    description: 'Dashboards',
  },
];
const INFRA = [
  {
    id: 'node-1',
    label: 'core-router',
    kind: 'ROUTER',
    status: 'ACTIVE',
    state: 'UP',
    ipAddress: '10.0.0.1',
    asset: { name: 'Cisco Catalyst switch' },
  },
  {
    id: 'node-2',
    label: 'db-vm',
    kind: 'VM',
    status: 'ACTIVE',
    state: 'DOWN',
    ipAddress: null,
    asset: null,
  },
];
const CONSUMABLES = [
  {
    id: 'cons-1',
    name: 'USB-C cable',
    sku: 'CBL-USBC-1M',
    description: null,
    currentStock: 12,
    unit: 'units',
  },
];

const PURCHASES = [
  {
    id: 'po-1',
    reference: 'OC-4512',
    status: 'ORDERED',
    orderDate: new Date('2026-09-12T00:00:00.000Z'),
    invoiceNumbers: 'A-0001-00001234',
    createdAt: new Date('2026-09-12T10:30:00.000Z'),
    supplier: { name: 'Compumundo' },
    lines: [{ description: 'ThinkPad T14 Gen 5' }],
  },
];
const SUPPLIERS = [
  {
    id: 'sup-1',
    name: 'Compumundo',
    taxId: '30-71234567-8',
    salesContactName: 'Ana Gómez',
    supportContactName: null,
  },
];

/**
 * A Prisma double answering the self-heal's `findMany` loads with the fixture rows above. The search
 * read's article `updatedAt` lookup (#1539) hits the same `article.findMany`, which ignores its `where`
 * and returns both fixture rows — the enrichment matches them to hits by id.
 */
function prismaFixture(): PrismaService {
  const rows = (data: unknown[]) => ({
    findMany: jest.fn().mockResolvedValue(data),
  });
  return {
    asset: rows(ASSETS),
    article: rows(ARTICLES),
    user: rows(USERS),
    location: rows(LOCATIONS),
    application: rows(APPLICATIONS),
    infraNode: rows(INFRA),
    consumable: rows(CONSUMABLES),
    purchaseOrder: rows(PURCHASES),
    supplier: rows(SUPPLIERS),
  } as unknown as PrismaService;
}

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  setContext: jest.fn(),
} as unknown as PinoLogger;

/** A folder-access double: the caller sees exactly `visible` (drives the Meili-side article filter). */
function folderAccess(visible: VisibleFolders): FolderAccessService {
  return {
    visibleFolderIds: jest.fn().mockResolvedValue(visible),
  } as unknown as FolderAccessService;
}

/** A permission double for the purchase-index gate (#1499): this suite reads purchases. */
const permissions = {
  principalHas: jest.fn().mockResolvedValue(true),
} as unknown as PermissionResolverService;

/** Poll `probe` until it holds (fire-and-forget writes return before the engine task completes). */
async function eventually(probe: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('condition not met within 10s');
}

describe('Meilisearch wire (pinned server image)', () => {
  let client: Meilisearch;

  beforeAll(async () => {
    if (!HOST || !KEY) {
      throw new Error(
        'search.wire.spec needs MEILI_HOST and MEILI_MASTER_KEY pointing at a throwaway Meilisearch ' +
          '(CI starts the meilisearch service from compose.yaml, i.e. the pinned image).',
      );
    }
    client = new Meilisearch({ host: HOST, apiKey: KEY });
    expect(await client.isHealthy()).toBe(true);
    // Start from an engine with none of our indexes — the state right after a server upgrade (#1216).
    for (const index of SEARCH_INDEXES) {
      await client.deleteIndexIfExists(index);
    }
  });

  afterAll(async () => {
    if (!client) return;
    for (const index of SEARCH_INDEXES) {
      await client.deleteIndexIfExists(index).catch(() => undefined);
    }
  });

  it('reports the server version it ran against (for the CI log)', async () => {
    const version = await client.getVersion();

    console.log(`Meilisearch server ${version.pkgVersion}`);
    expect(version.pkgVersion).toMatch(/^1\./);
  });

  it('self-heal on an EMPTY engine rebuilds every index from the database (new data volume)', async () => {
    const search = new SearchService(
      logger,
      folderAccess('ALL'),
      permissions,
      prismaFixture(),
    );
    expect(await search.isHealthy()).toBe(true);
    expect((await search.emptyOrMissingIndexes()).sort()).toEqual(
      [...SEARCH_INDEXES].sort(),
    );

    const bootstrap = new SearchBootstrapService(search, prismaFixture());
    const healed = await bootstrap.selfHeal({ attempts: 3, intervalMs: 500 });

    expect(healed.sort()).toEqual([...SEARCH_INDEXES].sort());
    // The stats probe now sees every index populated → the next boot is a no-op.
    expect(await search.emptyOrMissingIndexes()).toEqual([]);

    // The swap left no temp index behind.
    const { results } = await client.getIndexes({ limit: 100 });
    expect(results.map((i) => i.uid).sort()).toEqual(
      [...SEARCH_INDEXES].sort(),
    );

    // The filterable attributes were applied to the live index through the swap.
    expect(
      (await client.index('articles').getFilterableAttributes()) ?? [],
    ).toContain('categoryId');
    expect(
      ((await client.index('infra').getFilterableAttributes()) ?? []).sort(),
    ).toEqual(['kind', 'state', 'status']);
  });

  it('cross-entity search returns the retrievable hit fields only', async () => {
    const search = new SearchService(
      logger,
      folderAccess('ALL'),
      permissions,
      prismaFixture(),
    );
    const results = await search.search({ q: 'vpn', limit: 20 });

    expect(results.degraded).toBeUndefined();
    const titles = (results.articles?.hits ?? []).map(
      (h) => (h as { title: string }).title,
    );
    expect(titles.sort()).toEqual(['VPN admin runbook', 'VPN setup runbook']);
    for (const hit of results.articles?.hits ?? []) {
      // `content` is searchable but never retrieved (SEC-061). A surviving hit ships its home folder
      // and its live `updatedAt` from the database (#1539).
      expect(hit).not.toHaveProperty('content');
      expect(hit).toHaveProperty('categoryId');
      expect(hit).toHaveProperty('updatedAt');
    }

    // Full-text over the (non-retrievable) article body still matches.
    const body = await search.search({
      q: 'wireguard',
      entities: ['articles'],
      limit: 20,
    });
    expect(body.articles?.total).toBe(2);

    const cable = await search.search({
      q: 'CBL-USBC',
      entities: ['consumables'],
      limit: 5,
    });
    expect(cable.consumables?.hits[0]).toEqual({
      id: 'cons-1',
      name: 'USB-C cable',
      sku: 'CBL-USBC-1M',
      description: null,
      currentStock: 12,
      unit: 'units',
    });

    // #1499: a purchase is found by what it bought (the line description is searchable) but the hit
    // carries display fields only; a supplier by a contact name, which is not returned.
    const purchase = await search.search({
      q: 'ThinkPad',
      entities: ['purchases'],
      limit: 5,
    });
    expect(purchase.purchases?.hits[0]).toEqual({
      id: 'po-1',
      reference: 'OC-4512',
      supplierName: 'Compumundo',
      invoiceNumbers: 'A-0001-00001234',
      status: 'ORDERED',
      orderDate: '2026-09-12T00:00:00.000Z',
      createdAt: '2026-09-12T10:30:00.000Z',
    });
    // Dates and status are display-only (searchable attributes pinned in reindex.ts): a date token like
    // "2026" or "10" — both in the fixture's ISO dates — matches no purchase.
    for (const token of ['2026', '10', 'ORDERED']) {
      const dated = await search.search({
        q: token,
        entities: ['purchases'],
        limit: 5,
      });
      expect(dated.purchases?.total).toBe(0);
    }
    expect(
      (await client.index('purchases').getSearchableAttributes()) ?? [],
    ).toEqual([
      'reference',
      'supplierName',
      'invoiceNumbers',
      'lineDescriptions',
    ]);

    const supplier = await search.search({
      q: 'Gómez',
      entities: ['suppliers'],
      limit: 5,
    });
    expect(supplier.suppliers?.hits[0]).toEqual({
      id: 'sup-1',
      name: 'Compumundo',
      taxId: '30-71234567-8',
    });

    const node = await search.search({
      q: 'Catalyst',
      entities: ['infra', 'assets'],
      limit: 5,
    });
    expect(node.infra?.hits.map((h) => (h as { id: string }).id)).toEqual([
      'node-1',
    ]);
    expect(node.assets?.hits.map((h) => (h as { id: string }).id)).toEqual([
      'asset-2',
    ]);
  });

  it('the article folder filter is accepted by the server and scopes the query', async () => {
    const scoped = new SearchService(
      logger,
      folderAccess(new Set(['folder-public'])),
      permissions,
      prismaFixture(),
    );
    const res = await scoped.search({
      q: 'vpn',
      entities: ['articles'],
      limit: 20,
    });
    expect(res.degraded).toBeUndefined();
    expect(res.articles?.hits.map((h) => (h as { id: string }).id)).toEqual([
      'art-public',
    ]);
    expect(res.articles?.total).toBe(1);

    // Fail-closed never-match expression for a caller with no visible folders — must stay valid syntax.
    const none = new SearchService(
      logger,
      folderAccess(new Set()),
      permissions,
      prismaFixture(),
    );
    const empty = await none.search({
      q: 'vpn',
      entities: ['articles'],
      limit: 20,
    });
    expect(empty.degraded).toBeUndefined();
    expect(empty.articles).toEqual({ hits: [], total: 0 });
  });

  it('the infra filterable attributes accept a filter query', async () => {
    const res = await client
      .index('infra')
      .search('', { filter: "kind = 'VM' AND state = 'DOWN'" });
    expect(res.hits.map((h) => String(h.id))).toEqual(['node-2']);
  });

  it('fire-and-forget upsert and remove reach the engine', async () => {
    const search = new SearchService(
      logger,
      folderAccess('ALL'),
      permissions,
      prismaFixture(),
    );
    search.upsert(
      'users',
      projectUser({
        id: 'user-2',
        firstName: 'Grace',
        lastName: 'Hopper',
        email: 'grace@example.test',
      }),
    );
    await eventually(async () => {
      const r = await search.search({
        q: 'Hopper',
        entities: ['users'],
        limit: 5,
      });
      return r.users?.total === 1;
    });

    search.remove('users', 'user-2');
    await eventually(async () => {
      const r = await search.search({
        q: 'Hopper',
        entities: ['users'],
        limit: 5,
      });
      return r.users?.total === 0;
    });
  });

  it('a full rebuild evicts ghosts (reindexIndex swap over an existing index)', async () => {
    // A ghost: indexed, but no longer in the live set.
    await client
      .index('locations')
      .addDocuments([{ id: 'loc-ghost', name: 'Old Annex' }], {
        primaryKey: 'id',
      })
      .waitTask();

    await reindexIndex(client, 'locations', LOCATIONS.map(projectLocation));

    const ids = (await client.index('locations').getDocuments()).results.map(
      (d) => String(d.id),
    );
    expect(ids).toEqual(['loc-1']);
  });

  it('every projector shape round-trips through the engine', async () => {
    const shapes = {
      assets: ASSETS.map(projectAsset),
      articles: ARTICLES.map(projectArticle),
      applications: APPLICATIONS.map(projectApplication),
      infra: INFRA.map(projectInfraNode),
      consumables: CONSUMABLES.map(projectConsumable),
      purchases: PURCHASES.map(projectPurchaseOrder),
      suppliers: SUPPLIERS.map(projectSupplier),
    } as const;
    for (const [index, docs] of Object.entries(shapes)) {
      const stored = await client.index(index).getDocument(docs[0].id);
      expect(stored).toEqual(docs[0]);
    }
  });
});
