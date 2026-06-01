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
// Minimal User shapes for tests — the full Prisma User type, but only id matters here.
type MinimalUser = { id: string };
const AUTHOR_USER: MinimalUser = { id: AUTHOR };
const OTHER_USER: MinimalUser = { id: OTHER };

// Shapes we assert against the recorded Prisma calls (the jest.Mock arrays are otherwise `any`).
type ArticleData = {
  slug?: string;
  title?: string;
  content?: string;
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

describe('ArticlesService', () => {
  let service: ArticlesService;
  let article: ArticleMock;
  let articleVersion: ArticleVersionMock;
  let articleLink: ArticleLinkMock;
  let articleCategory: { findFirst: jest.Mock };
  let asset: { findFirst: jest.Mock };
  let application: { findFirst: jest.Mock };
  let prisma: { $transaction: jest.Mock };
  // ActorService is mocked; guard validation lives in jwt-auth.guard.spec.ts. By default it echoes
  // a present user's id back (any caller with a User "exists") and maps undefined to anonymous.
  let actor: { resolve: jest.Mock };
  let search: { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

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
    // $transaction supports BOTH shapes the service uses:
    //   - array form (findPage / listVersions): await the tuple of promises;
    //   - interactive callback form (create/update/publish/unpublish/import): invoke the callback
    //     with a `tx` exposing the same model mocks, so the snapshot write hits articleVersion.
    const tx = { article, articleVersion, articleLink };
    prisma = {
      $transaction: jest.fn(
        (
          arg:
            | Array<Promise<unknown>>
            | ((client: typeof tx) => Promise<unknown>),
        ) => (typeof arg === 'function' ? arg(tx) : Promise.all(arg)),
      ),
    };
    // Any present User resolves to its id; undefined → anonymous (no user).
    // resolve() is now synchronous — returns string | undefined directly.
    actor = {
      resolve: jest.fn().mockImplementation((u?: MinimalUser) => u?.id),
    };
    // Category / asset / application exist by default; overridden per-test.
    articleCategory = { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) };
    asset = { findFirst: jest.fn().mockResolvedValue({ id: 'as1' }) };
    application = { findFirst: jest.fn().mockResolvedValue({ id: 'app1' }) };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArticlesService,
        {
          provide: PrismaService,
          useValue: {
            article,
            articleVersion,
            articleLink,
            articleCategory,
            asset,
            application,
            ...prisma,
          },
        },
        { provide: ActorService, useValue: actor },
        { provide: SearchService, useValue: search },
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

  // --- create --------------------------------------------------------------

  describe('create', () => {
    it('sets author from current user, autogenerates the slug, leaves a DRAFT unpublished', async () => {
      await service.create(
        {
          title: 'My First Article',
          content: 'body',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR_USER as never,
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
        AUTHOR_USER as never,
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
        AUTHOR_USER as never,
      );
      expect(lastCreate().slug).toBe('custom-slug');
    });

    it('rejects when current user is missing (400)', async () => {
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it("propagates a thrown error from the actor resolver (a required author can't be resolved)", async () => {
      actor.resolve.mockImplementationOnce(() => {
        throw new BadRequestException('actor error');
      });
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          AUTHOR_USER as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing / soft-deleted category (400)', async () => {
      articleCategory.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'gone', status: 'DRAFT' },
          AUTHOR_USER as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });
  });

  // --- listing visibility (paginated, lean) --------------------------------

  describe('findPage visibility', () => {
    const PAGE = { limit: 50, offset: 0 };

    it('shows only PUBLISHED to anonymous callers', async () => {
      await service.findPage({}, PAGE, undefined);
      expect(listWhere().AND[0]).toEqual({ status: 'PUBLISHED' });
      expect(actor.resolve).toHaveBeenCalledWith(undefined);
    });

    it("shows PUBLISHED plus the caller's own DRAFTs when logged in", async () => {
      await service.findPage({}, PAGE, AUTHOR_USER as never);
      expect(listWhere().AND[0]).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: AUTHOR }],
      });
    });

    it('applies category / author / status / q filters', async () => {
      await service.findPage(
        { categoryId: 'c1', authorId: AUTHOR, status: 'PUBLISHED', q: 'vpn' },
        PAGE,
        undefined,
      );
      const and = listWhere().AND;
      expect(and).toContainEqual({ categoryId: 'c1' });
      expect(and).toContainEqual({ authorId: AUTHOR });
      expect(and).toContainEqual({ status: 'PUBLISHED' });
      expect(and).toContainEqual({
        OR: [
          { title: { contains: 'vpn', mode: 'insensitive' } },
          { excerpt: { contains: 'vpn', mode: 'insensitive' } },
        ],
      });
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

    it('uses the LEAN select: omits `content`, keeps `excerpt`', async () => {
      await service.findPage({}, { limit: 50, offset: 0 }, undefined);
      const select = listArgs().select;
      expect(select).not.toHaveProperty('content');
      expect(select.excerpt).toBe(true);
      expect(select.title).toBe(true);
    });

    it('runs findMany(take/skip) + count over the SAME where inside one $transaction', async () => {
      article.findMany.mockResolvedValueOnce([{ id: 'art1' }]);
      article.count.mockResolvedValueOnce(9);

      const result = await service.findPage(
        { status: 'PUBLISHED' },
        { limit: 5, offset: 10 },
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
      // The Page<T> envelope.
      expect(result).toEqual({
        items: [{ id: 'art1' }],
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
      await service.update('a', { title: 'New title' }, AUTHOR_USER as never);
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

    it('returns 403 for a non-author on a PUBLISHED article', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'PUBLISHED',
        authorId: AUTHOR,
      });
      await expect(
        service.update('a', { title: 'x' }, OTHER_USER as never),
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
        service.update('a', { title: 'x' }, OTHER_USER as never),
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
        service.update('a', { categoryId: 'gone' }, AUTHOR_USER as never),
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
      await service.publish('a', AUTHOR_USER as never);
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
      await service.publish('a', AUTHOR_USER as never);
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
      await service.unpublish('a', AUTHOR_USER as never);
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
        service.publish('a', OTHER_USER as never),
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
      await service.remove('a', AUTHOR_USER as never);
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
      await expect(
        service.remove('a', OTHER_USER as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(article.update).not.toHaveBeenCalled();
    });
  });

  // --- import --------------------------------------------------------------

  describe('importArticle', () => {
    const file = (name: string, body: string) => ({
      originalname: name,
      buffer: Buffer.from(body),
      size: Buffer.byteLength(body),
    });

    it('imports a .md, deriving the title from the filename', async () => {
      await service.importArticle(
        file('network-guide.md', '# Net'),
        { categoryId: 'c1', status: 'DRAFT' },
        AUTHOR_USER as never,
      );
      const data = lastCreate();
      expect(data.title).toBe('network guide');
      expect(data.slug).toBe('network-guide');
      expect(data.content).toContain('# Net');
      expect(data.authorId).toBe(AUTHOR);
      expect(data.publishedAt).toBeNull();
      // Imported as DRAFT -> not indexed (draft privacy, ADR-0022/0035).
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('indexes an imported article when imported as PUBLISHED', async () => {
      await service.importArticle(
        file('guide.md', '# Net'),
        { categoryId: 'c1', status: 'PUBLISHED' },
        AUTHOR_USER as never,
      );
      expect(search.upsert).toHaveBeenCalledWith(
        'articles',
        expect.objectContaining({ status: 'PUBLISHED', slug: 'guide' }),
      );
    });

    it('rejects a file over the size limit (400)', async () => {
      const big = {
        originalname: 'big.md',
        buffer: Buffer.alloc(1),
        size: 6 * 1024 * 1024,
      };
      await expect(
        service.importArticle(
          big,
          { categoryId: 'c1', status: 'DRAFT' },
          AUTHOR_USER as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('rejects a missing file (400)', async () => {
      await expect(
        service.importArticle(
          undefined,
          { categoryId: 'c1', status: 'DRAFT' },
          AUTHOR_USER as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty file (400)', async () => {
      await expect(
        service.importArticle(
          file('empty.txt', '   '),
          { categoryId: 'c1', status: 'DRAFT' },
          AUTHOR_USER as never,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('requires current user (400 when user is undefined)', async () => {
      await expect(
        service.importArticle(
          file('a.md', '# x'),
          { categoryId: 'c1', status: 'DRAFT' },
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

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
        AUTHOR_USER as never,
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

    it('snapshots version 1 on import', async () => {
      const body = '# Guide\nbody';
      await service.importArticle(
        {
          originalname: 'guide.md',
          buffer: Buffer.from(body),
          size: Buffer.byteLength(body),
        },
        { categoryId: 'c1', status: 'DRAFT' },
        AUTHOR_USER as never,
      );
      expect(articleVersion.create).toHaveBeenCalledTimes(1);
      expect(lastVersion()).toMatchObject({ version: 1, editedById: AUTHOR });
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
      await service.update('a', { title: 'New' }, AUTHOR_USER as never);
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
        AUTHOR_USER as never,
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
      await service.publish('a', AUTHOR_USER as never);
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
      await service.publish('a', AUTHOR_USER as never);
      expect(articleVersion.create).not.toHaveBeenCalled();
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
        { limit: 50, offset: 0 },
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
          { limit: 50, offset: 0 },
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
        AUTHOR_USER as never,
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
      await service.addLink(
        'a',
        { applicationId: 'app1' },
        AUTHOR_USER as never,
      );
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
        service.addLink('a', { assetId: 'gone' }, AUTHOR_USER as never),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(articleLink.create).not.toHaveBeenCalled();
    });

    it('blocks a non-author from linking a PUBLISHED article (403)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      await expect(
        service.addLink('a', { assetId: 'as1' }, OTHER_USER as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(articleLink.create).not.toHaveBeenCalled();
    });

    it('removes a link the article owns (author only)', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      articleLink.findFirst.mockResolvedValueOnce({
        id: 'link1',
        articleId: 'a',
      });
      await service.removeLink('a', 'link1', AUTHOR_USER as never);
      expect(articleLink.delete).toHaveBeenCalledWith({
        where: { id: 'link1' },
      });
    });

    it('404s removing a link that does not belong to the article', async () => {
      article.findFirst.mockResolvedValue(PUBLISHED_OWNED);
      articleLink.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.removeLink('a', 'nope', AUTHOR_USER as never),
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
        { id: 'a', status: 'PUBLISHED' },
      ]);
      await service.findArticlesForAsset('as1');
      const where = (
        article.findMany.mock.calls as Array<
          [{ where: Record<string, unknown> }]
        >
      ).at(-1)![0].where;
      expect(where).toMatchObject({
        status: 'PUBLISHED',
        links: { some: { assetId: 'as1' } },
      });
    });

    it('reverse lookup for an application lists only PUBLISHED linked articles (lean shape)', async () => {
      article.findMany.mockResolvedValueOnce([
        { id: 'a', status: 'PUBLISHED' },
      ]);

      await service.findArticlesForApplication('app1');

      const call = (
        article.findMany.mock.calls as Array<
          [{ where: Record<string, unknown>; select: Record<string, unknown> }]
        >
      ).at(-1)![0];
      expect(call.where).toMatchObject({
        status: 'PUBLISHED',
        links: { some: { applicationId: 'app1' } },
      });
      // Lean projection: the full markdown `content` is never requested.
      expect(call.select).not.toHaveProperty('content');
      expect(call.select).toHaveProperty('excerpt', true);
    });
  });

  // Slug uniqueness (409) and FK integrity are enforced by the database (unique index / FKs) and
  // mapped to HTTP by PrismaExceptionFilter; they are verified at runtime, not here, since this
  // suite mocks Prisma (see docs/03-decisions/0012-testing-strategy.md and ADR-0021). The
  // exactly-one-target CHECK and duplicate-link partial uniques (ADR-0042) are likewise DB-enforced;
  // the zod `.refine` that guards exactly-one at the edge is unit-tested in @lazyit/shared.
});
