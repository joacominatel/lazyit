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

describe('ArticlesService', () => {
  let service: ArticlesService;
  let article: ArticleMock;
  let articleCategory: { findFirst: jest.Mock };
  let prisma: {
    article: ArticleMock;
    articleCategory: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  // ActorService is mocked; X-User-Id validation lives in actor.service.spec.ts. By default it echoes
  // a present id back (any well-formed caller "exists") and maps empty/undefined to anonymous.
  let actor: { resolve: jest.Mock };
  let search: { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

  beforeEach(async () => {
    article = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
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
      count: jest.fn().mockResolvedValue(0),
    };
    // Any present id resolves to itself (a live caller); empty/undefined → anonymous. Overridden
    // per-test for the rejecting case.
    actor = {
      resolve: jest
        .fn()
        .mockImplementation((id?: string) =>
          Promise.resolve(id === undefined || id === '' ? undefined : id),
        ),
    };
    // Category exists by default; overridden per-test.
    articleCategory = { findFirst: jest.fn().mockResolvedValue({ id: 'c1' }) };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // findPage runs [findMany, count] in a batch $transaction — resolve the promise array together.
    prisma = {
      article,
      articleCategory,
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArticlesService,
        { provide: PrismaService, useValue: prisma },
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

  // --- create --------------------------------------------------------------

  describe('create', () => {
    it('sets author from X-User-Id, autogenerates the slug, leaves a DRAFT unpublished', async () => {
      await service.create(
        {
          title: 'My First Article',
          content: 'body',
          categoryId: 'c1',
          status: 'DRAFT',
        },
        AUTHOR,
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
        AUTHOR,
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
        AUTHOR,
      );
      expect(lastCreate().slug).toBe('custom-slug');
    });

    it('rejects when X-User-Id is missing (400)', async () => {
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('propagates a 400 from the actor resolver (malformed / unknown X-User-Id)', async () => {
      // The shim-validation detail is in actor.service.spec.ts; here a write must surface a rejecting
      // resolve as a 400 (a required author can't be resolved).
      actor.resolve.mockRejectedValueOnce(
        new BadRequestException('X-User-Id is not a valid user id'),
      );
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'c1', status: 'DRAFT' },
          'bad-actor',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a missing / soft-deleted category (400)', async () => {
      articleCategory.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.create(
          { title: 'X', content: 'b', categoryId: 'gone', status: 'DRAFT' },
          AUTHOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });
  });

  // --- listing visibility + pagination (ADR-0030) --------------------------

  const DEFAULT_PAGE = { limit: 50, offset: undefined, page: undefined } as const;

  describe('findPage visibility', () => {
    it('shows only PUBLISHED to anonymous callers', async () => {
      await service.findPage({}, DEFAULT_PAGE, undefined);
      expect(listWhere().AND[0]).toEqual({ status: 'PUBLISHED' });
      expect(actor.resolve).toHaveBeenCalledWith(undefined);
    });

    it("shows PUBLISHED plus the caller's own DRAFTs when logged in", async () => {
      await service.findPage({}, DEFAULT_PAGE, AUTHOR);
      expect(listWhere().AND[0]).toEqual({
        OR: [{ status: 'PUBLISHED' }, { status: 'DRAFT', authorId: AUTHOR }],
      });
    });

    it('applies category / author / status / q filters', async () => {
      await service.findPage(
        { categoryId: 'c1', authorId: AUTHOR, status: 'PUBLISHED', q: 'vpn' },
        DEFAULT_PAGE,
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

  describe('findPage lean projection + envelope', () => {
    it('omits the markdown `content` from the list select (keeps `excerpt`)', async () => {
      await service.findPage({}, DEFAULT_PAGE, undefined);
      const select = (
        article.findMany.mock.calls as Array<[{ select: Record<string, unknown> }]>
      )[0][0].select;
      expect(select).not.toHaveProperty('content');
      expect(select.excerpt).toBe(true);
      expect(select.title).toBe(true);
    });

    it('returns a Page envelope (items + total + effective limit/offset)', async () => {
      article.findMany.mockResolvedValueOnce([
        { id: 'a1', slug: 's', title: 'T', excerpt: null, status: 'PUBLISHED' },
      ]);
      article.count.mockResolvedValueOnce(42);

      const result = await service.findPage(
        {},
        { limit: 10, offset: 20, page: undefined },
        undefined,
      );

      expect(result.total).toBe(42);
      expect(result.limit).toBe(10);
      expect(result.offset).toBe(20);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).not.toHaveProperty('content');
    });

    it('applies the offset/limit window and counts with the same where', async () => {
      await service.findPage({ status: 'PUBLISHED' }, { limit: 25, offset: 50, page: undefined }, undefined);
      const findManyArg = (
        article.findMany.mock.calls as Array<[{ where: unknown; take: number; skip: number }]>
      )[0][0];
      const countWhere = (
        article.count.mock.calls as Array<[{ where: unknown }]>
      )[0][0].where;
      expect(findManyArg.take).toBe(25);
      expect(findManyArg.skip).toBe(50);
      expect(countWhere).toEqual(findManyArg.where);
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
      await expect(service.findOne('a', OTHER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('shows a DRAFT to its author', async () => {
      article.findFirst.mockResolvedValue({
        id: 'a',
        status: 'DRAFT',
        authorId: AUTHOR,
      });
      await expect(service.findOne('a', AUTHOR)).resolves.toMatchObject({
        id: 'a',
      });
    });

    it('404s when the article is missing', async () => {
      article.findFirst.mockResolvedValue(null);
      await expect(service.findBySlug('nope', AUTHOR)).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
      await service.update('a', { title: 'New title' }, AUTHOR);
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
        service.update('a', { title: 'x' }, OTHER),
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
        service.update('a', { title: 'x' }, OTHER),
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
        service.update('a', { categoryId: 'gone' }, AUTHOR),
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
      await service.publish('a', AUTHOR);
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
      await service.publish('a', AUTHOR);
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
      await service.unpublish('a', AUTHOR);
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
      await expect(service.publish('a', OTHER)).rejects.toBeInstanceOf(
        NotFoundException,
      );
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
      await service.remove('a', AUTHOR);
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
      await expect(service.remove('a', OTHER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
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
        AUTHOR,
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
        AUTHOR,
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
          AUTHOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('rejects a missing file (400)', async () => {
      await expect(
        service.importArticle(
          undefined,
          { categoryId: 'c1', status: 'DRAFT' },
          AUTHOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an empty file (400)', async () => {
      await expect(
        service.importArticle(
          file('empty.txt', '   '),
          { categoryId: 'c1', status: 'DRAFT' },
          AUTHOR,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(article.create).not.toHaveBeenCalled();
    });

    it('requires X-User-Id (400)', async () => {
      await expect(
        service.importArticle(
          file('a.md', '# x'),
          { categoryId: 'c1', status: 'DRAFT' },
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // Slug uniqueness (409) and FK integrity are enforced by the database (unique index / FKs) and
  // mapped to HTTP by PrismaExceptionFilter; they are verified at runtime, not here, since this
  // suite mocks Prisma (see docs/03-decisions/0012-testing-strategy.md and ADR-0021).
});
