import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ArticlesService } from './articles.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { SearchService } from '../search/search.service';
import { FolderAccessService } from '../article-categories/folder-access.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// ArticlesService transitively imports the ESM `meilisearch` package (via SearchService); jest
// can't transform it. SearchService is replaced by a mock below; this stub stops the real load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

const AUTHOR = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const SA_ID = 'sa_abcdefghijklmnopqrstuvwx';
// Minimal User shapes for tests — the full Prisma User type, but only id matters here. The READS still
// take a `User` (@CurrentUser); the WRITES take the unified PRINCIPAL (@CurrentPrincipal, ADR-0048).
type MinimalUser = { id: string };
const AUTHOR_USER: MinimalUser = { id: AUTHOR };
const OTHER_USER: MinimalUser = { id: OTHER };
// Human principals for the write paths; cast through `never` (only the user id drives authorship).
const AUTHOR_PRINCIPAL = { kind: 'human', user: { id: AUTHOR } } as never;
const OTHER_PRINCIPAL = { kind: 'human', user: { id: OTHER } } as never;
// A service-account principal — an SA can never author/own an article (Article.authorId is a non-null
// User FK), so the write paths must reject it (403) rather than write a null-attributed version.
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(),
} as never;

// Shapes we assert against the recorded Prisma calls (the jest.Mock arrays are otherwise `any`).
type ArticleData = {
  slug?: string;
  title?: string;
  content?: string;
  readingMinutes?: number;
  status?: string;
  categoryId?: string;
  authorId?: string;
  lastEditedById?: string | null;
  publishedAt?: Date | null;
  deletedAt?: Date;
};
type WhereArg = {
  where: { deletedAt: null; AND: Array<Record<string, unknown>> };
};

type ArticleMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

// ArticleVersion is append-only (ADR-0042); the service only ever create/aggregate/findMany/findFirst/count.
type ArticleVersionMock = {
  create: jest.Mock;
  aggregate: jest.Mock;
  findMany: jest.Mock;
  findFirst: jest.Mock;
  count: jest.Mock;
};
// ArticleLink CRUD (ADR-0042).
type ArticleLinkMock = {
  create: jest.Mock;
  delete: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
};
// ArticleWikiLink (ADR-0059 §3/§4): a derived projection — the service only ever
// deleteMany/createMany (the rebuild) and findMany (the backlinks read).
type ArticleWikiLinkMock = {
  deleteMany: jest.Mock;
  createMany: jest.Mock;
  findMany: jest.Mock;
};
// ArticleAlias (ADR-0059 §2): current-state join — create / delete / findFirst / findMany.
type ArticleAliasMock = {
  create: jest.Mock;
  delete: jest.Mock;
  findFirst: jest.Mock;
  findMany: jest.Mock;
};

describe('ArticlesService', () => {
  let service: ArticlesService;
  let article: ArticleMock;
  let articleVersion: ArticleVersionMock;
  let articleLink: ArticleLinkMock;
  let articleWikiLink: ArticleWikiLinkMock;
  let articleAlias: ArticleAliasMock;
  let articleCategory: { findFirst: jest.Mock };
  let asset: { findFirst: jest.Mock };
  let application: { findFirst: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  // ActorService is mocked; guard validation lives in jwt-auth.guard.spec.ts. By default it echoes
  // a present user's id back (any caller with a User "exists") and maps undefined to anonymous.
  let actor: ActorService;
  let search: { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };
  // FolderAccessService (ADR-0060 §4) — mocked; defaults to 'ALL' (sees every folder) so the pre-0060
  // tests are unaffected. Folder-access invariants are tested in folder-access.service.spec.ts; the
  // 404/no-escalation paths here override visibleFolderIds with a Set.
  let folderAccess: { visibleFolderIds: jest.Mock };

  beforeEach(async () => {
    article = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockImplementation((args: { data: ArticleData }) => ({
        id: 'art1',
        ...args.data,
      })),
      update: jest
        .fn()
        .mockImplementation(
          (args: { where: { id: string }; data: ArticleData }) => ({
            id: args.where.id,
            ...args.data,
          }),
        ),
    };
    articleVersion = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      // No prior versions by default → nextVersion() returns 1.
      aggregate: jest.fn().mockResolvedValue({ _max: { version: null } }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    };
    articleLink = {
      create: jest
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) => ({
          id: 'link1',
          ...args.data,
        })),
      delete: jest.fn().mockResolvedValue({ id: 'link1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    };
    articleWikiLink = {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    };
    articleAlias = {
      create: jest
        .fn()
        .mockImplementation((args: { data: Record<string, unknown> }) => ({
          id: 'alias1',
          ...args.data,
        })),
      delete: jest.fn().mockResolvedValue({ id: 'alias1' }),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    };
    // $transaction supports BOTH shapes the service uses:
    //   - array form (findPage / listVersions): await the tuple of promises;
    //   - interactive callback form (create/update/publish/unpublish/import): invoke the callback
    //     with a `tx` exposing the same model mocks, so the snapshot write hits articleVersion and
    //     the wiki-link rebuild hits articleWikiLink (ADR-0059 §3).
    const tx = { article, articleVersion, articleLink, articleWikiLink };
    prisma = {
      $transaction: jest.fn(
        (
          arg:
            | Array<Promise<unknown>>
            | ((client: typeof tx) => Promise<unknown>),
        ) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg)),
      ),
    };
    // ActorService is a pure resolver (the guard already validated the caller); the real instance is
    // used. Reads delegate to resolve(user) for draft visibility; writes read principal.user.id directly.
    actor = new ActorService();
    // Category / asset / application exist by default; overridden per-test.
    articleCategory = { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) };
    asset = { findFirst: jest.fn().mockResolvedValue({ id: 'as1' }) };
    application = { findFirst: jest.fn().mockResolvedValue({ id: 'app1' }) };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // FolderAccessService (ADR-0060 §4): default to 'ALL' (ADMIN-equivalent "sees every folder") so the
    // pre-0060 tests stay behavior-preserving — folder access never narrows unless a test wires it.
    // The dedicated folder-access invariant tests live in folder-access.service.spec.ts; the few here
    // override visibleFolderIds to a Set to drive the folder-hidden 404 / no-escalation paths.
    folderAccess = { visibleFolderIds: jest.fn().mockResolvedValue('ALL') };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArticlesService,
        {
          provide: PrismaService,
          useValue: {
            article,
            articleVersion,
            articleLink,
            articleWikiLink,
            articleAlias,
            articleCategory,
            asset,
            application,
            ...prisma,
          },
        },
        { provide: ActorService, useValue: actor },
        { provide: SearchService, useValue: search },
        { provide: FolderAccessService, useValue: folderAccess },
      ],
    }).compile();

    service = moduleRef.get(ArticlesService);
  });

  const lastCreate = (): ArticleData =>
    (article.create.mock.calls as Array<[{ data: ArticleData }]>)[0][0].data;
  const lastUpdate = (): ArticleData =>
    (article.update.mock.calls as Array<[{ data: ArticleData }]>)[0][0].data;
  const listWhere = (): WhereArg['where'] =>
    (article.findMany.mock.calls as Array<[WhereArg]>)[0][0].where;
  // The data of the latest ArticleVersion snapshot the service appended.
  const lastVersion = (): Record<string, unknown> =>
    (
      articleVersion.create.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >
    ).at(-1)![0].data;
  // Normalized page window for the reverse KB lookups (#220) — the controller passes this shape.
  const REVERSE_PAGE = { limit: 50, offset: 0, deleted: 'active' as const };
  // The `where` of the LAST `article.findMany` call — the reverse lookups build a `{ AND: [...] }`.
  const lastReverseWhere = (): { AND: Array<Record<string, unknown>> } =>
    (
      article.findMany.mock.calls as Array<
        [{ where: { AND: Array<Record<string, unknown>> } }]
      >
    ).at(-1)![0].where;

  // --- create --------------------------------------------------------------

  describe('create', () => {
    it('sets author from the current human principal, autogenerates the slug, leaves a DRAFT unpublished', async () => {
      await service.create(
        {
          title: 'My First Article',
          content: 'body',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      const data = lastCreate();
      expect(data.authorId).toBe(AUTHOR);
      expect(data.slug).toBe('my-first-article');
      expect(data.status).toBe('DRAFT');
      expect(data.publishedAt).toBeNull();
      // Draft privacy (ADR-0022/0035): a new DRAFT must NOT be indexed.
      expect(search.upsert).not.toHaveBeenCalled();
      expect(search.remove).not.toHaveBeenCalled();
    });

    it('sets publishedAt when created already PUBLISHED', async () => {
      await service.create(
        { title: 'Live', content: 'b', categoryId: 'c1', status: 'PUBLISHED' },
        AUTHOR_PRINCIPAL,
      );
      expect(lastCreate().publishedAt).toBeInstanceOf(Date);
      // A PUBLISHED article is indexed on create (ADR-0035).
      expect(search.upsert).toHaveBeenCalledWith(
        'articles',
        expect.objectContaining({
          id: 'art1',
          title: 'Live',
          slug: 'live',
          status: 'PUBLISHED',
        }),
      );
    });

    it('uses an explicit slug when provided', async () => {
      await service.create(
        {
          title: 'Whatever',
          slug: 'custom-slug',
          content: 'b',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      expect(lastCreate().slug).toBe('custom-slug');
    });

    it('maintains the readingMinutes metric from the body (~200 wpm, min 1 for non-empty)', async () => {
      await service.create(
        {
          title: 'Long',
          content: Array.from({ length: 450 }, (_, i) => `word${i}`).join(' '),
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      // 450 words / 200 = 2.25 → ceil → 3 minutes.
      expect(lastCreate().readingMinutes).toBe(3);
    });

    it('a short body still reads as 1 minute (never 0 for non-empty content)', async () => {
      await service.create(
        {
          title: 'Tiny',
          content: 'a few words',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      expect(lastCreate().readingMinutes).toBe(1);
    });

    it('rejects when there is no authenticated principal (400)', async () => {
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('rejects a SERVICE-ACCOUNT principal (403): an SA cannot author an article — ADR-0048', async () => {
      // Article.authorId is a non-null User FK; an SA has no user identity to own an article, so the
      // write path rejects rather than producing a null-attributed version row.
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          SA_PRINCIPAL,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('rejects a missing / soft-deleted category (400)', async () => {
      articleCategory.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'gone', status: 'DRAFT' },
          AUTHOR_PRINCIPAL,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });
  });

  // --- listing visibility (paginated, lean) --------------------------------

  describe('findPage visibility', () => {
    const PAGE = { limit: 50, offset: 0, deleted: 'active' as const };

    it('shows only PUBLISHED to anonymous callers', async () => {
      await service.findPage({}, PAGE, undefined);
      // Anonymous (no resolved user) → the visibility filter restricts to PUBLISHED only.
      expect(listWhere().AND[0]).toEqual({ status: 'PUBLISHED' });
    });

    it("shows PUBLISHED plus the caller's own DRAFTs when logged in", async () => {
      await service.findPage({}, PAGE, AUTHOR_USER as never);
      expect(listWhere().AND[0]).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: AUTHOR }],
      });
    });

    it('applies category / author / status / q filters (single value → IN with one element)', async () => {
      await service.findPage(
        {
          categoryId: ['c1'],
          authorId: AUTHOR,
          status: ['PUBLISHED'],
          q: 'vpn',
        },
        PAGE,
        undefined,
      );
      const and = listWhere().AND;
      // Multi-select shape (#198): a single value is still threaded as a one-element `{ in: [...] }`.
      expect(and).toContainEqual({ categoryId: { in: ['c1'] } });
      expect(and).toContainEqual({ authorId: AUTHOR });
      expect(and).toContainEqual({ status: { in: ['PUBLISHED'] } });
      expect(and).toContainEqual({
        OR: [
          { title: { contains: 'vpn', mode: 'insensitive' } },
          { excerpt: { contains: 'vpn', mode: 'insensitive' } },
        ],
      });
    });

    it('multi-value status → `status: { in: [...] }` (OR within the filter, #198)', async () => {
      await service.findPage(
        { status: ['DRAFT', 'PUBLISHED'] },
        PAGE,
        undefined,
      );
      expect(listWhere().AND).toContainEqual({
        status: { in: ['DRAFT', 'PUBLISHED'] },
      });
    });

    it('multi-value categoryId → `categoryId: { in: [...] }` (OR within the filter, #198)', async () => {
      await service.findPage({ categoryId: ['c1', 'c2'] }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({
        categoryId: { in: ['c1', 'c2'] },
      });
    });

    it('an empty filter array is omitted (no `categoryId`/`status` IN clause, #198)', async () => {
      // The anonymous visibility gate (AND[0]) carries `status: 'PUBLISHED'`, so we assert the absence
      // of the multi-select `{ in: [...] }` clauses specifically, not any `status`/`categoryId` key.
      await service.findPage({ categoryId: [], status: [] }, PAGE, undefined);
      const and = listWhere().AND;
      const hasInClause = (key: 'categoryId' | 'status') =>
        and.some((c) => {
          const v = c[key];
          return typeof v === 'object' && v !== null && 'in' in v;
        });
      expect(hasInClause('categoryId')).toBe(false);
      expect(hasInClause('status')).toBe(false);
    });

    it('no link filter by default: the where has no `links` clause (linked AND unlinked included)', async () => {
      await service.findPage({}, PAGE, undefined);
      const and = listWhere().AND;
      expect(and.some((c) => 'links' in c)).toBe(false);
    });

    it('linked=only restricts to articles with ≥1 link (relation `some`, no target narrowing)', async () => {
      await service.findPage({ linked: 'only' }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({ links: { some: {} } });
    });

    it('linkedTo=[asset] narrows the link filter to articles linked to an Asset', async () => {
      await service.findPage({ linkedTo: ['asset'] }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({
        links: { some: { assetId: { not: null } } },
      });
    });

    it('linkedTo=[application] narrows to articles linked to an Application', async () => {
      await service.findPage({ linkedTo: ['application'] }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({
        links: { some: { applicationId: { not: null } } },
      });
    });

    it('linkedTo=[asset, application] unions both kinds → any link counts (#198)', async () => {
      // Both kinds selected = "has ≥1 link to an Asset OR an Application" = an unnarrowed `some: {}`.
      await service.findPage(
        { linkedTo: ['asset', 'application'] },
        PAGE,
        undefined,
      );
      expect(listWhere().AND).toContainEqual({ links: { some: {} } });
    });

    // --- specific-entity link filters (#213) -------------------------------

    it('assetId=[as1, as2] narrows to articles linked to one of those exact assets (`{ in }`, #213)', async () => {
      await service.findPage({ assetId: ['as1', 'as2'] }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({
        links: { some: { assetId: { in: ['as1', 'as2'] } } },
      });
    });

    it('applicationId=[app1] narrows to articles linked to that exact application (`{ in }`, #213)', async () => {
      await service.findPage({ applicationId: ['app1'] }, PAGE, undefined);
      expect(listWhere().AND).toContainEqual({
        links: { some: { applicationId: { in: ['app1'] } } },
      });
    });

    it('a specific assetId selection implies linked=only even without the linked param (#213)', async () => {
      // No `linked` passed — the entity selection alone produces a `links` clause (linked-only).
      await service.findPage({ assetId: ['as1'] }, PAGE, undefined);
      const and = listWhere().AND;
      expect(and.some((c) => 'links' in c)).toBe(true);
    });

    it('a specific assetId selection WINS over a redundant linkedTo=asset (entity narrowing, #213)', async () => {
      // linkedTo=asset is "any asset"; the specific ids are more granular, so the `{ in }` wins —
      // the broad `{ assetId: { not: null } }` is not emitted.
      await service.findPage(
        { linkedTo: ['asset'], assetId: ['as1'] },
        PAGE,
        undefined,
      );
      const and = listWhere().AND;
      expect(and).toContainEqual({
        links: { some: { assetId: { in: ['as1'] } } },
      });
      expect(and).not.toContainEqual({
        links: { some: { assetId: { not: null } } },
      });
    });

    it('assetId + applicationId OR across two `some` EXISTS (linked to these assets OR these apps, #213)', async () => {
      await service.findPage(
        { assetId: ['as1'], applicationId: ['app1'] },
        PAGE,
        undefined,
      );
      expect(listWhere().AND).toContainEqual({
        OR: [
          { links: { some: { assetId: { in: ['as1'] } } } },
          { links: { some: { applicationId: { in: ['app1'] } } } },
        ],
      });
    });

    it('specific assetId + kind-only linkedTo=application → entity `{ in }` ORs with the broad app kind (#213)', async () => {
      // Asset side narrows to the specific id; application side stays the broad kind predicate.
      await service.findPage(
        { assetId: ['as1'], linkedTo: ['application'] },
        PAGE,
        undefined,
      );
      expect(listWhere().AND).toContainEqual({
        OR: [
          { links: { some: { assetId: { in: ['as1'] } } } },
          { links: { some: { applicationId: { not: null } } } },
        ],
      });
    });

    it('empty assetId/applicationId arrays are omitted (no specific-entity `links` clause, #213)', async () => {
      await service.findPage(
        { assetId: [], applicationId: [] },
        PAGE,
        undefined,
      );
      const and = listWhere().AND;
      expect(and.some((c) => 'links' in c || 'OR' in c)).toBe(false);
    });

    it('the specific-entity filter is ANDed on TOP of the visibility rule (draft privacy still honored, #213)', async () => {
      await service.findPage({ assetId: ['as1'] }, PAGE, AUTHOR_USER as never);
      const and = listWhere().AND;
      expect(and[0]).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: AUTHOR }],
      });
      expect(and).toContainEqual({
        links: { some: { assetId: { in: ['as1'] } } },
      });
    });

    it('the linked filter is ANDed on TOP of the visibility rule (draft privacy still honored)', async () => {
      // The first AND clause is always the visibility gate; the linked clause is added, not replacing it.
      await service.findPage({ linked: 'only' }, PAGE, AUTHOR_USER as never);
      const and = listWhere().AND;
      expect(and[0]).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: AUTHOR }],
      });
      expect(and).toContainEqual({ links: { some: {} } });
    });
  });

  describe('findPage pagination & lean projection', () => {
    // Asserts the lean select omits the markdown `content` (and keeps `excerpt`), runs findMany +
    // count over the same where in one $transaction, and returns the Page<T> envelope.
    const listArgs = (): {
      where: unknown;
      orderBy: unknown;
      take: number;
      skip: number;
      select: Record<string, unknown>;
    } =>
      (
        article.findMany.mock.calls as Array<
          [
            {
              where: unknown;
              orderBy: unknown;
              take: number;
              skip: number;
              select: Record<string, unknown>;
            },
          ]
        >
      )[0][0];

    it('uses the LEAN select: omits `content`, keeps `excerpt`, adds the metric + link count', async () => {
      await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'active' },
        undefined,
      );
      const select = listArgs().select;
      expect(select).not.toHaveProperty('content');
      expect(select.excerpt).toBe(true);
      expect(select.title).toBe(true);
      // The card affordances are produced by the query (no body load, no N+1).
      expect(select.readingMinutes).toBe(true);
      expect(select._count).toEqual({ select: { links: true } });
    });

    it('flattens Prisma `_count.links` into a `linkCount` and surfaces `readingMinutes` per row', async () => {
      article.findMany.mockResolvedValueOnce([
        {
          id: 'art1',
          title: 'Linked',
          excerpt: null,
          readingMinutes: 3,
          _count: { links: 2 },
        },
        {
          id: 'art2',
          title: 'Lonely',
          excerpt: null,
          readingMinutes: 1,
          _count: { links: 0 },
        },
      ]);
      article.count.mockResolvedValueOnce(2);

      const result = await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'active' },
        undefined,
      );

      // `_count` is dropped from the wire shape; `linkCount` carries the tally, readingMinutes passes through.
      expect(result.items).toEqual([
        {
          id: 'art1',
          title: 'Linked',
          excerpt: null,
          readingMinutes: 3,
          linkCount: 2,
        },
        {
          id: 'art2',
          title: 'Lonely',
          excerpt: null,
          readingMinutes: 1,
          linkCount: 0,
        },
      ]);
      expect(result.items[0]).not.toHaveProperty('_count');
    });

    it('runs findMany(take/skip) + count over the SAME where inside one $transaction', async () => {
      article.findMany.mockResolvedValueOnce([
        { id: 'art1', readingMinutes: 2, _count: { links: 0 } },
      ]);
      article.count.mockResolvedValueOnce(9);

      const result = await service.findPage(
        { status: ['PUBLISHED'] },
        { limit: 5, offset: 10, deleted: 'active' },
        undefined,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const fm = listArgs();
      const countWhere = (
        article.count.mock.calls as Array<[{ where: unknown }]>
      )[0][0].where;
      expect(fm.take).toBe(5);
      expect(fm.skip).toBe(10);
      expect(fm.orderBy).toEqual({ updatedAt: 'desc' });
      // count's where is identical to the page's where (so total can't drift from the page).
      expect(countWhere).toEqual(fm.where);
      // The Page<T> envelope — `_count` flattened to `linkCount`.
      expect(result).toEqual({
        items: [{ id: 'art1', readingMinutes: 2, linkCount: 0 }],
        total: 9,
        limit: 5,
        offset: 10,
      });
    });
  });

  // --- read visibility -----------------------------------------------------

  describe('findOne / findBySlug visibility', () => {
    it('returns a PUBLISHED article to anyone', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await expect(service.findOne('a', undefined)).resolves.toMatchObject({
        id: 'a',
      });
    });

    it('hides a DRAFT from a non-author (404, not 403)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.findOne('a', OTHER_USER as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows a DRAFT to its author', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.findOne('a', AUTHOR_USER as never),
      ).resolves.toMatchObject({
        id: 'a',
      });
    });

    it('404s when the article is missing', async () => {
      article.findFirst.mockResolvedValue(null);
      await expect(
        service.findBySlug('nope', AUTHOR_USER as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // --- ADR-0060 §4 folder access composes on top of draft visibility ---------

    it('hides a PUBLISHED article in a folder the caller CANNOT see (404, NOT 403)', async () => {
      // The article is PUBLISHED (passes draft visibility) but its home folder is restricted and not in
      // the caller's visible set → folder-hidden → 404 (existence-hiding), never a 403.
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        categoryId: 'secret-folder',
      });
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['public-folder']),
      );
      await expect(
        service.findOne('a', OTHER_USER as never, OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('shows a PUBLISHED article in a folder the caller CAN see', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        categoryId: 'shared-folder',
      });
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['shared-folder']),
      );
      await expect(
        service.findOne('a', OTHER_USER as never, OTHER_PRINCIPAL),
      ).resolves.toMatchObject({ id: 'a' });
    });

    it('ADMIN (visibleFolderIds = ALL) sees an article in any folder', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        categoryId: 'secret-folder',
      });
      folderAccess.visibleFolderIds.mockResolvedValue('ALL');
      await expect(
        service.findOne('a', OTHER_USER as never, OTHER_PRINCIPAL),
      ).resolves.toMatchObject({ id: 'a' });
    });
  });

  // --- author-only writes --------------------------------------------------

  describe('update authorization', () => {
    it('lets the author update and records the editor', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      // The real prisma.update returns the full row (status included); reflect that so the search
      // sync sees the resulting status.
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 'a-slug',
        title: 'New title',
        excerpt: null,
        status: 'PUBLISHED',
        lastEditedById: AUTHOR,
      });
      await service.update('a', { title: 'New title' }, AUTHOR_PRINCIPAL);
      expect(lastUpdate()).toEqual({
        title: 'New title',
        lastEditedById: AUTHOR,
      });
      // A PUBLISHED article stays indexed after an edit (ADR-0035).
      expect(search.upsert).toHaveBeenCalledWith('articles', {
        id: 'a',
        slug: 'a-slug',
        title: 'New title',
        excerpt: null,
        status: 'PUBLISHED',
      });
      expect(search.remove).not.toHaveBeenCalled();
    });

    it('recomputes readingMinutes when the edit changes `content`', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        title: 't',
        content: 'old',
        excerpt: null,
      });
      await service.update(
        'a',
        { content: Array.from({ length: 250 }, () => 'w').join(' ') },
        AUTHOR_PRINCIPAL,
      );
      // 250 words / 200 = 1.25 → ceil → 2 minutes.
      expect(lastUpdate().readingMinutes).toBe(2);
    });

    it('leaves readingMinutes untouched on a metadata/title-only edit (content absent)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        title: 't',
        content: 'body',
        excerpt: null,
      });
      await service.update('a', { title: 'Renamed' }, AUTHOR_PRINCIPAL);
      expect(lastUpdate()).not.toHaveProperty('readingMinutes');
    });

    it('returns 403 for a non-author on a PUBLISHED article', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await expect(
        service.update('a', { title: 'x' }, OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(article.update).not.toHaveBeenCalled();
    });

    it('returns 404 for a non-author on a DRAFT', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.update('a', { title: 'x' }, OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('validates a changed categoryId (400 if not live)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      articleCategory.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.update('a', { categoryId: 'gone' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // --- publish / unpublish -------------------------------------------------

  describe('publish / unpublish', () => {
    it('publishes a DRAFT, setting publishedAt and the editor', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        publishedAt: null,
      });
      await service.publish('a', AUTHOR_PRINCIPAL);
      const data = lastUpdate();
      expect(data.status).toBe('PUBLISHED');
      expect(data.publishedAt).toBeInstanceOf(Date);
      expect(data.lastEditedById).toBe(AUTHOR);
      // Publishing makes the article searchable (ADR-0035).
      expect(search.upsert).toHaveBeenCalledWith(
        'articles',
        expect.objectContaining({ id: 'a', status: 'PUBLISHED' }),
      );
      expect(search.remove).not.toHaveBeenCalled();
    });

    it('is a no-op when already PUBLISHED (no update)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        publishedAt: new Date(),
      });
      await service.publish('a', AUTHOR_PRINCIPAL);
      expect(article.update).not.toHaveBeenCalled();
      // Idempotent short-circuit: already indexed, no redundant sync.
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('unpublishes a PUBLISHED article back to DRAFT but keeps publishedAt', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        publishedAt: new Date(),
      });
      await service.unpublish('a', AUTHOR_PRINCIPAL);
      const data = lastUpdate();
      expect(data.status).toBe('DRAFT');
      expect(data).not.toHaveProperty('publishedAt');
      // Back to author-private: dropped from the index (ADR-0035).
      expect(search.remove).toHaveBeenCalledWith('articles', 'a');
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('blocks a non-author from publishing a DRAFT (404)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.publish('a', OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --- remove --------------------------------------------------------------

  describe('remove', () => {
    it('soft-deletes for the author', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await service.remove('a', AUTHOR_PRINCIPAL);
      const data = lastUpdate();
      expect(data.deletedAt).toBeInstanceOf(Date);
      expect(data.lastEditedById).toBe(AUTHOR);
      // Soft-delete drops the article from the index (ADR-0035).
      expect(search.remove).toHaveBeenCalledWith('articles', 'a');
    });

    it('returns 403 for a non-author on a PUBLISHED article', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await expect(service.remove('a', OTHER_PRINCIPAL)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(article.update).not.toHaveBeenCalled();
    });
  });

  // --- import --------------------------------------------------------------
  // Article import is now ASYNC (ADR-0053): parse + create moved out of ArticlesService into the
  // sandboxed worker. Its behavior is covered by import/create-imported-article.spec.ts (the create
  // path) and import/docx-bomb.spec.ts (SEC-002 isolation); the enqueue/status edge lives in
  // ArticleImportService.

  // --- versioning (append-only edit history, ADR-0042) ---------------------

  describe('versioning — snapshot on write', () => {
    it('snapshots version 1 on create, capturing the editable state', async () => {
      await service.create(
        {
          title: 'Runbook',
          content: '## body',
          excerpt: 'a runbook',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      expect(articleVersion.create).toHaveBeenCalledTimes(1);
      const v = lastVersion();
      expect(v).toMatchObject({
        articleId: 'art1',
        version: 1,
        title: 'Runbook',
        content: '## body',
        excerpt: 'a runbook',
        status: 'DRAFT',
        editedById: AUTHOR,
      });
    });

    it('appends the NEXT version on an edit that changes a versioned field', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        title: 'Old',
        content: 'old body',
        excerpt: null,
      });
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 's',
        title: 'New',
        content: 'old body',
        excerpt: null,
        status: 'PUBLISHED',
      });
      // Two prior versions exist → next is 3.
      articleVersion.aggregate.mockResolvedValueOnce({ _max: { version: 2 } });
      await service.update('a', { title: 'New' }, AUTHOR_PRINCIPAL);
      expect(articleVersion.create).toHaveBeenCalledTimes(1);
      expect(lastVersion()).toMatchObject({
        articleId: 'a',
        version: 3,
        title: 'New',
        editedById: AUTHOR,
      });
    });

    it('does NOT snapshot a metadata-only / no-op edit (no versioned field changed)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        title: 'Same',
        content: 'same body',
        excerpt: null,
      });
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 's',
        title: 'Same',
        content: 'same body',
        excerpt: null,
        status: 'PUBLISHED',
      });
      await service.update(
        'a',
        { metadata: { reviewed: true } },
        AUTHOR_PRINCIPAL,
      );
      expect(article.update).toHaveBeenCalled();
      expect(articleVersion.create).not.toHaveBeenCalled();
    });

    it('snapshots on publish (status changed DRAFT → PUBLISHED)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        publishedAt: null,
        title: 'T',
        content: 'b',
        excerpt: null,
      });
      article.update.mockResolvedValueOnce({
        id: 'a',
        status: 'PUBLISHED',
        title: 'T',
        content: 'b',
        excerpt: null,
      });
      await service.publish('a', AUTHOR_PRINCIPAL);
      expect(articleVersion.create).toHaveBeenCalledTimes(1);
      expect(lastVersion()).toMatchObject({ status: 'PUBLISHED', version: 1 });
    });

    it('does NOT snapshot an idempotent publish (already PUBLISHED)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        publishedAt: new Date(),
      });
      await service.publish('a', AUTHOR_PRINCIPAL);
      expect(articleVersion.create).not.toHaveBeenCalled();
    });
  });

  describe('restoreVersion (#848)', () => {
    it('replays an old version through the edit path: appends a NEW version with the old content, keeps the current status', async () => {
      // loadOwned (here + inside update) reads the LIVE article — currently PUBLISHED.
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
        title: 'New title',
        content: 'new body',
        excerpt: null,
      });
      // The old snapshot being restored — a DRAFT with different content and an excerpt.
      articleVersion.findFirst.mockResolvedValueOnce({
        id: 5,
        articleId: 'a',
        version: 1,
        title: 'Old title',
        content: 'old body',
        excerpt: 'old excerpt',
        status: 'DRAFT',
      });
      // update() writes the row back; status is the CURRENT status (update never touches it).
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 's',
        title: 'Old title',
        content: 'old body',
        excerpt: 'old excerpt',
        status: 'PUBLISHED',
      });
      // Two versions already exist → the restore appends version 3.
      articleVersion.aggregate.mockResolvedValueOnce({ _max: { version: 2 } });

      await service.restoreVersion('a', 1, AUTHOR_PRINCIPAL);

      // The edit path was driven with the old content fields only — never `status`.
      expect(lastUpdate()).toMatchObject({
        title: 'Old title',
        content: 'old body',
        excerpt: 'old excerpt',
        lastEditedById: AUTHOR,
      });
      expect(lastUpdate()).not.toHaveProperty('status');
      // A NEW append-only version was written: old content, but the CURRENT (published) status.
      expect(articleVersion.create).toHaveBeenCalledTimes(1);
      expect(lastVersion()).toMatchObject({
        articleId: 'a',
        version: 3,
        title: 'Old title',
        content: 'old body',
        excerpt: 'old excerpt',
        status: 'PUBLISHED',
        editedById: AUTHOR,
      });
    });

    it('404s when the requested version does not exist (and writes nothing)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      articleVersion.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.restoreVersion('a', 99, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(article.update).not.toHaveBeenCalled();
    });
  });

  describe('versioning — read', () => {
    it('lists versions newest-first, paginated, over the same where as the count', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      articleVersion.findMany.mockResolvedValueOnce([
        { id: 2, articleId: 'a', version: 2 },
        { id: 1, articleId: 'a', version: 1 },
      ]);
      articleVersion.count.mockResolvedValueOnce(2);
      const page = await service.listVersions(
        'a',
        { limit: 50, offset: 0, deleted: 'active' },
        AUTHOR_USER as never,
      );
      expect(page).toEqual({
        items: [
          { id: 2, articleId: 'a', version: 2 },
          { id: 1, articleId: 'a', version: 1 },
        ],
        total: 2,
        limit: 50,
        offset: 0,
      });
      const findArgs = (
        articleVersion.findMany.mock.calls as Array<
          [{ where: unknown; orderBy: unknown }]
        >
      )[0][0];
      expect(findArgs.where).toEqual({ articleId: 'a' });
      expect(findArgs.orderBy).toEqual({ version: 'desc' });
    });

    it("404s the version list when the caller can't read the article (a non-author's DRAFT)", async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.listVersions(
          'a',
          { limit: 50, offset: 0, deleted: 'active' },
          OTHER_USER as never,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleVersion.findMany).not.toHaveBeenCalled();
    });

    it('returns a single version by number, 404 when that version is absent', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      articleVersion.findFirst.mockResolvedValueOnce({
        id: 7,
        articleId: 'a',
        version: 3,
      });
      await expect(
        service.findVersion('a', 3, AUTHOR_USER as never),
      ).resolves.toMatchObject({ version: 3 });

      articleVersion.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.findVersion('a', 99, AUTHOR_USER as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // --- linking (article <-> asset/application, ADR-0042) -------------------

  describe('linking', () => {
    const PUBLISHED_OWNED = {
      id: 'a',
      status: 'PUBLISHED',
      authorId: AUTHOR,
    };

    it('links to an asset (author only), recording the creator', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      const link = await service.addLink(
        'a',
        { assetId: 'as1' },
        AUTHOR_PRINCIPAL,
      );
      expect(asset.findFirst).toHaveBeenCalled();
      expect(articleLink.create).toHaveBeenCalledWith({
        data: {
          articleId: 'a',
          assetId: 'as1',
          applicationId: null,
          createdById: AUTHOR,
        },
      });
      expect(link).toMatchObject({ articleId: 'a', assetId: 'as1' });
    });

    it('links to an application (author only)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      await service.addLink('a', { applicationId: 'app1' }, AUTHOR_PRINCIPAL);
      expect(application.findFirst).toHaveBeenCalled();
      expect(articleLink.create).toHaveBeenCalledWith({
        data: {
          articleId: 'a',
          assetId: null,
          applicationId: 'app1',
          createdById: AUTHOR,
        },
      });
    });

    it('rejects a link to a missing / soft-deleted asset (400)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      asset.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.addLink('a', { assetId: 'gone' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleLink.create).not.toHaveBeenCalled();
    });

    it('blocks a non-author from linking a PUBLISHED article (403)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      await expect(
        service.addLink('a', { assetId: 'as1' }, OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(articleLink.create).not.toHaveBeenCalled();
    });

    it('no-escalation (ADR-0060 §6 / INV-9 — #556): cannot link a target whose HOME folder the actor cannot see (404)', async () => {
      // The actor IS the author (passes the author gate) but the article's home folder is no longer
      // visible to them (offboarding / admin move / self-move). §6 forbids surfacing an article you
      // cannot yourself read — and a link IS a surfacing channel (the reverse lookup, #553). The link
      // is rejected as 404 (folder-hidden), never written — mirroring the alias no-escalation gate.
      article.findFirst.mockResolvedValue({
        ...PUBLISHED_OWNED,
        categoryId: 'secret-folder',
      });
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['some-other-folder']),
      );
      await expect(
        service.addLink('a', { assetId: 'as1' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleLink.create).not.toHaveBeenCalled();
      // The target-liveness check is never even reached — the folder gate fails first.
      expect(asset.findFirst).not.toHaveBeenCalled();
    });

    it('links a target whose HOME folder the actor CAN see (happy path still works — #556)', async () => {
      article.findFirst.mockResolvedValue({
        ...PUBLISHED_OWNED,
        categoryId: 'shared-folder',
      });
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['shared-folder']),
      );
      await service.addLink('a', { assetId: 'as1' }, AUTHOR_PRINCIPAL);
      expect(articleLink.create).toHaveBeenCalledWith({
        data: {
          articleId: 'a',
          assetId: 'as1',
          applicationId: null,
          createdById: AUTHOR,
        },
      });
    });

    it('removes a link the article owns (author only)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      articleLink.findFirst.mockResolvedValueOnce({
        id: 'link1',
        articleId: 'a',
      });
      await service.removeLink('a', 'link1', AUTHOR_PRINCIPAL);
      expect(articleLink.delete).toHaveBeenCalledWith({
        where: { id: 'link1' },
      });
    });

    it('404s removing a link that does not belong to the article', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      articleLink.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.removeLink('a', 'nope', AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleLink.delete).not.toHaveBeenCalled();
    });

    it('lists an article links to any reader; reverse lists only PUBLISHED articles for an asset', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      articleLink.findMany.mockResolvedValueOnce([
        { id: 'link1', articleId: 'a' },
      ]);
      await expect(
        service.findLinks('a', AUTHOR_USER as never),
      ).resolves.toEqual([{ id: 'link1', articleId: 'a' }]);

      article.findMany.mockResolvedValueOnce([
        { id: 'a', status: 'PUBLISHED', _count: { links: 1 } },
      ]);
      await service.findArticlesForAsset('as1', {}, REVERSE_PAGE);
      const and = lastReverseWhere().AND;
      // The hard PUBLISHED pin + the asset scope are the first two AND clauses.
      expect(and).toContainEqual({ status: 'PUBLISHED' });
      expect(and).toContainEqual({ links: { some: { assetId: 'as1' } } });
    });

    it('reverse lookup for an application returns a PUBLISHED-only PAGE (lean shape, flattened linkCount)', async () => {
      // findMany returns the lean rows (nested `_count.links`); count returns the matching total.
      article.findMany.mockResolvedValueOnce([
        { id: 'a', status: 'PUBLISHED', _count: { links: 2 } },
      ]);
      article.count.mockResolvedValueOnce(1);

      const result = await service.findArticlesForApplication(
        'app1',
        {},
        REVERSE_PAGE,
      );

      // Page envelope (ADR-0030): { items, total, limit, offset }; `_count.links` flattened to linkCount.
      expect(result).toMatchObject({ total: 1, limit: 50, offset: 0 });
      expect(result.items).toEqual([
        { id: 'a', status: 'PUBLISHED', linkCount: 2 },
      ]);

      const call = (
        article.findMany.mock.calls as Array<
          [
            {
              where: Record<string, unknown>;
              select: Record<string, unknown>;
              take: number;
              skip: number;
            },
          ]
        >
      ).at(-1)![0];
      expect(
        (call.where as { AND: Array<Record<string, unknown>> }).AND,
      ).toEqual(
        expect.arrayContaining([
          { status: 'PUBLISHED' },
          { links: { some: { applicationId: 'app1' } } },
        ]),
      );
      // take/skip thread the page window (ADR-0030) — no unbounded findMany.
      expect(call.take).toBe(50);
      expect(call.skip).toBe(0);
      // Lean projection: the full markdown `content` is never requested.
      expect(call.select).not.toHaveProperty('content');
      expect(call.select).toHaveProperty('excerpt', true);
    });

    it('paginates the reverse list: take/skip thread the window and total echoes the matching count (#220)', async () => {
      article.findMany.mockResolvedValueOnce([
        { id: 'b', status: 'PUBLISHED', _count: { links: 0 } },
      ]);
      article.count.mockResolvedValueOnce(42);

      const result = await service.findArticlesForAsset(
        'as1',
        {},
        {
          limit: 10,
          offset: 20,
          deleted: 'active' as const,
        },
      );

      // The total comes from the paired count over the same where — not the page length (1 row here).
      expect(result.total).toBe(42);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
      const call = (
        article.findMany.mock.calls as Array<[{ take: number; skip: number }]>
      ).at(-1)![0];
      expect(call.take).toBe(10);
      expect(call.skip).toBe(20);
      // The count runs over the SAME where as the page (so total can't drift).
      const findManyWhere = lastReverseWhere();
      const countWhere = (
        article.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
      ).at(-1)![0].where;
      expect(countWhere).toEqual(findManyWhere);
    });

    it('reverse list filters by q (case-insensitive substring over title/excerpt) (#220)', async () => {
      article.findMany.mockResolvedValueOnce([]);
      await service.findArticlesForApplication(
        'app1',
        { q: 'vpn' },
        REVERSE_PAGE,
      );
      expect(lastReverseWhere().AND).toContainEqual({
        OR: [
          { title: { contains: 'vpn', mode: 'insensitive' } },
          { excerpt: { contains: 'vpn', mode: 'insensitive' } },
        ],
      });
    });

    it('reverse list filters by categoryId (multi-select IN) (#220)', async () => {
      article.findMany.mockResolvedValueOnce([]);
      await service.findArticlesForAsset(
        'as1',
        { categoryId: ['c1', 'c2'] },
        REVERSE_PAGE,
      );
      expect(lastReverseWhere().AND).toContainEqual({
        categoryId: { in: ['c1', 'c2'] },
      });
    });

    it('reverse list status filter is ANDed on top of the hard PUBLISHED pin — never widens it (no draft leak) (#220)', async () => {
      article.findMany.mockResolvedValueOnce([]);
      // Even if a caller passes status=DRAFT, the PUBLISHED pin stays — the intersection matches nothing.
      await service.findArticlesForApplication(
        'app1',
        { status: ['DRAFT'] },
        REVERSE_PAGE,
      );
      const and = lastReverseWhere().AND;
      expect(and).toContainEqual({ status: 'PUBLISHED' });
      expect(and).toContainEqual({ status: { in: ['DRAFT'] } });
    });

    // --- ADR-0060 §4 folder access pins the reverse lookups too (INV-9 — #553) ---
    // A PUBLISHED article linked to an asset/application still must NOT surface (title/slug/excerpt)
    // through the reverse list if its home folder is hidden from the caller — the link is a surfacing
    // channel. The where is pinned to `categoryId IN <visible>`, exactly as findPage does. ADMIN ('ALL')
    // gets no pin. Resolved per call from the (mocked) FolderAccessService.

    it('reverse list (asset) is pinned to the caller visible folders — a folder-hidden article is filtered out (#553)', async () => {
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['public-folder']),
      );
      article.findMany.mockResolvedValueOnce([]);
      await service.findArticlesForAsset(
        'as1',
        {},
        REVERSE_PAGE,
        OTHER_PRINCIPAL,
      );
      // The caller's visible folder set is resolved DB-first per call (never cached).
      expect(folderAccess.visibleFolderIds).toHaveBeenCalledWith(
        OTHER_PRINCIPAL,
      );
      const and = lastReverseWhere().AND;
      // The folder pin is ANDed on top of the PUBLISHED + link scope, so a restricted article never
      // surfaces through the link scope (existence-hiding).
      expect(and).toContainEqual({ status: 'PUBLISHED' });
      expect(and).toContainEqual({ links: { some: { assetId: 'as1' } } });
      expect(and).toContainEqual({ categoryId: { in: ['public-folder'] } });
    });

    it('reverse list (application) is pinned to the caller visible folders too (#553)', async () => {
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['public-folder']),
      );
      article.findMany.mockResolvedValueOnce([]);
      await service.findArticlesForApplication(
        'app1',
        {},
        REVERSE_PAGE,
        OTHER_PRINCIPAL,
      );
      expect(folderAccess.visibleFolderIds).toHaveBeenCalledWith(
        OTHER_PRINCIPAL,
      );
      const and = lastReverseWhere().AND;
      expect(and).toContainEqual({
        links: { some: { applicationId: 'app1' } },
      });
      expect(and).toContainEqual({ categoryId: { in: ['public-folder'] } });
    });

    it('ADMIN (visibleFolderIds = ALL) gets NO folder pin on the reverse list — sees an article in any folder (#553)', async () => {
      folderAccess.visibleFolderIds.mockResolvedValue('ALL');
      article.findMany.mockResolvedValueOnce([]);
      await service.findArticlesForAsset(
        'as1',
        {},
        REVERSE_PAGE,
        AUTHOR_PRINCIPAL,
      );
      const and = lastReverseWhere().AND;
      // No `categoryId` clause is added for an ADMIN — the link scope + PUBLISHED pin stand alone.
      expect(and).toContainEqual({ status: 'PUBLISHED' });
      expect(
        and.some((c) => Object.prototype.hasOwnProperty.call(c, 'categoryId')),
      ).toBe(false);
    });
  });

  // --- wiki-links: rebuild on save (ADR-0059 §3) ---------------------------

  describe('wiki-link rebuild on save', () => {
    // The data passed to the last articleWikiLink.createMany.
    const lastCreateMany = (): Array<{
      sourceArticleId: string;
      targetSlug: string;
      resolvedTargetId: string | null;
    }> =>
      (
        articleWikiLink.createMany.mock.calls as Array<
          [{ data: Array<Record<string, unknown>> }]
        >
      ).at(-1)![0].data as never;

    it('rebuilds edges on create: deletes then inserts one per distinct [[slug]], in the txn', async () => {
      // The body resolves [[network-setup]] (live) and [[not-yet]] (unresolved).
      article.findMany.mockResolvedValueOnce([
        { id: 'tgt1', slug: 'network-setup' },
      ]);
      await service.create(
        {
          title: 'Runbook',
          content:
            'See [[network-setup]] and [[not-yet]] and [[network-setup]] again',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      // Delete-then-insert, both via the SAME tx (one $transaction, ADR-0042 discipline).
      expect(articleWikiLink.deleteMany).toHaveBeenCalledWith({
        where: { sourceArticleId: 'art1' },
      });
      const rows = lastCreateMany();
      // Distinct slugs only; the repeated [[network-setup]] collapses to one edge.
      expect(rows).toEqual([
        {
          sourceArticleId: 'art1',
          targetSlug: 'network-setup',
          resolvedTargetId: 'tgt1', // resolved to the live article
        },
        {
          sourceArticleId: 'art1',
          targetSlug: 'not-yet',
          resolvedTargetId: null, // unresolved forward reference — never blocks the save
        },
      ]);
    });

    it('clears edges (deleteMany) but inserts nothing when the body has no [[slug]] tokens', async () => {
      await service.create(
        {
          title: 'Plain',
          content: 'no links here',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_PRINCIPAL,
      );
      expect(articleWikiLink.deleteMany).toHaveBeenCalledWith({
        where: { sourceArticleId: 'art1' },
      });
      expect(articleWikiLink.createMany).not.toHaveBeenCalled();
    });

    it('rebuilds on an update that CHANGES content', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        title: 't',
        content: 'old [[gone]]',
        excerpt: null,
      });
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 's',
        title: 't',
        content: 'new [[fresh]]',
        excerpt: null,
        status: 'DRAFT',
      });
      article.findMany.mockResolvedValueOnce([]); // [[fresh]] unresolved
      await service.update('a', { content: 'new [[fresh]]' }, AUTHOR_PRINCIPAL);
      expect(articleWikiLink.deleteMany).toHaveBeenCalledWith({
        where: { sourceArticleId: 'a' },
      });
      expect(lastCreateMany()).toEqual([
        { sourceArticleId: 'a', targetSlug: 'fresh', resolvedTargetId: null },
      ]);
    });

    it('does NOT rebuild on a metadata/title-only update (content unchanged)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
        title: 'old',
        content: 'body [[x]]',
        excerpt: null,
      });
      article.update.mockResolvedValueOnce({
        id: 'a',
        slug: 's',
        title: 'new',
        content: 'body [[x]]', // unchanged
        excerpt: null,
        status: 'DRAFT',
      });
      await service.update('a', { title: 'new' }, AUTHOR_PRINCIPAL);
      expect(articleWikiLink.deleteMany).not.toHaveBeenCalled();
      expect(articleWikiLink.createMany).not.toHaveBeenCalled();
    });

    it('is idempotent: re-saving the same body yields the same edge set', async () => {
      article.findMany.mockResolvedValue([{ id: 'tgt1', slug: 'a' }]);
      const body = 'link [[a]] and [[a]]';
      await service.create(
        { title: 'One', content: body, categoryId: 'c1', status: 'DRAFT' },
        AUTHOR_PRINCIPAL,
      );
      const first = lastCreateMany();
      await service.create(
        { title: 'Two', content: body, categoryId: 'c1', status: 'DRAFT' },
        AUTHOR_PRINCIPAL,
      );
      const second = lastCreateMany();
      // Same distinct target set both times (idempotent rebuild).
      expect(first.map((r) => r.targetSlug)).toEqual(['a']);
      expect(second.map((r) => r.targetSlug)).toEqual(['a']);
    });
  });

  // --- backlinks ("References") read (ADR-0059 §4) -------------------------

  describe('backlinks', () => {
    it('returns incoming wiki-links whose resolved target is this article, with source slug/title', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      articleWikiLink.findMany.mockResolvedValueOnce([
        {
          id: 'wl1',
          sourceArticleId: 'src1',
          createdAt: new Date('2026-06-12T00:00:00.000Z'),
          source: { slug: 'src-slug', title: 'Source One' },
        },
      ]);
      const result = await service.backlinks('a', AUTHOR_USER as never);
      expect(result).toEqual([
        {
          id: 'wl1',
          sourceArticleId: 'src1',
          sourceSlug: 'src-slug',
          sourceTitle: 'Source One',
          createdAt: '2026-06-12T00:00:00.000Z',
        },
      ]);
      // The query keys on resolvedTargetId = the article id (the reverse of the edge).
      const where = (
        articleWikiLink.findMany.mock.calls as Array<
          [{ where: Record<string, unknown> }]
        >
      )[0][0].where;
      expect(where.resolvedTargetId).toBe('a');
    });

    it('ANDs the SOURCE visibility gate so a draft backlink never leaks to a non-author', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await service.backlinks('a', OTHER_USER as never);
      const where = (
        articleWikiLink.findMany.mock.calls as Array<
          [{ where: { source: unknown } }]
        >
      )[0][0].where;
      // A non-author sees PUBLISHED sources plus their OWN drafts — not the target author's drafts.
      expect(where.source).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: OTHER }],
      });
    });

    it('404s when the TARGET itself is a draft the caller cannot read (no leak of its backlinks)', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(
        service.backlinks('a', OTHER_USER as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleWikiLink.findMany).not.toHaveBeenCalled();
    });
  });

  // --- aliases (nav-only folder symlinks, ADR-0059 §2) --------------------

  describe('aliases', () => {
    const OWNED = {
      id: 'a',
      status: 'PUBLISHED',
      authorId: AUTHOR,
      categoryId: 'home',
    };

    it('creates an alias into a live folder other than the home (author only)', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleCategory.findFirst.mockResolvedValueOnce({ id: 'other' });
      const alias = await service.addAlias(
        'a',
        { folderId: 'other' },
        AUTHOR_PRINCIPAL,
      );
      expect(articleAlias.create).toHaveBeenCalledWith({
        data: { articleId: 'a', folderId: 'other' },
      });
      expect(alias).toMatchObject({ articleId: 'a', folderId: 'other' });
    });

    it('rejects (400) an alias into a missing / soft-deleted folder', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleCategory.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.addAlias('a', { folderId: 'gone' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleAlias.create).not.toHaveBeenCalled();
    });

    it('rejects (400) an alias into the article OWN home folder', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleCategory.findFirst.mockResolvedValueOnce({ id: 'home' });
      await expect(
        service.addAlias('a', { folderId: 'home' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleAlias.create).not.toHaveBeenCalled();
    });

    it('blocks a non-author from aliasing a PUBLISHED article (403)', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      await expect(
        service.addAlias('a', { folderId: 'other' }, OTHER_PRINCIPAL),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(articleAlias.create).not.toHaveBeenCalled();
    });

    it('no-escalation (ADR-0060 §6 / INV-9): cannot alias a target whose HOME folder the actor cannot see (404)', async () => {
      // The actor IS the author (passes the author gate) but the article's home folder is no longer
      // visible to them (e.g. an asset-assignment rule whose assignment was released). §6 forbids
      // surfacing an article you cannot yourself read — the alias is rejected as 404 (folder-hidden),
      // never written. Belt-and-suspenders with the author gate.
      article.findFirst.mockResolvedValue(OWNED);
      folderAccess.visibleFolderIds.mockResolvedValue(
        new Set(['some-other-folder']),
      );
      await expect(
        service.addAlias('a', { folderId: 'other' }, AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleAlias.create).not.toHaveBeenCalled();
    });

    it('removes an alias the article owns via hard delete (author only)', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleAlias.findFirst.mockResolvedValueOnce({
        id: 'alias1',
        articleId: 'a',
      });
      await service.removeAlias('a', 'alias1', AUTHOR_PRINCIPAL);
      expect(articleAlias.delete).toHaveBeenCalledWith({
        where: { id: 'alias1' },
      });
    });

    it('404s removing an alias that does not belong to the article', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleAlias.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.removeAlias('a', 'nope', AUTHOR_PRINCIPAL),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(articleAlias.delete).not.toHaveBeenCalled();
    });

    it('lists aliases to any reader of the article', async () => {
      article.findFirst.mockResolvedValue(OWNED);
      articleAlias.findMany.mockResolvedValueOnce([
        { id: 'alias1', articleId: 'a', folderId: 'other' },
      ]);
      await expect(
        service.findAliases('a', AUTHOR_USER as never),
      ).resolves.toEqual([{ id: 'alias1', articleId: 'a', folderId: 'other' }]);
    });
  });

  // Slug uniqueness (409) and FK integrity are enforced by the database (unique index / FKs) and
  // mapped to HTTP by PrismaExceptionFilter; they are verified at runtime, not here, since this
  // suite mocks Prisma (see docs/03-decisions/0012-testing-strategy.md and ADR-0021). The
  // exactly-one-target CHECK and duplicate-link partial uniques (ADR-0042) are likewise DB-enforced;
  // the zod `.refine` that guards exactly-one at the edge is unit-tested in @lazyit/shared.
});
