import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ArticlesController } from './articles.controller';
import { ArticlesService } from './articles.service';
import { maxImportBytes } from './article-import';

// Mock the generated Prisma client so importing ArticlesService (the DI token) never loads the
// real one (no DB). The service itself is replaced by a mock below.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
// ArticlesService transitively imports the ESM `meilisearch` package (via SearchService); jest
// can't transform it. The service is mocked below, so this stub just stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * SEC-001 — the import endpoint must cap the upload at the multer interceptor, so an oversized file
 * is rejected before it is buffered into memory (DoS). With FileInterceptor's `limits.fileSize`,
 * multer aborts the stream early and platform-express maps `LIMIT_FILE_SIZE` to a 413, so the
 * service handler never runs. Without the cap the whole file is buffered and the handler runs.
 */
describe('ArticlesController POST /articles/import (upload size limit, SEC-001)', () => {
  let app: INestApplication;
  const importArticle = jest.fn();
  const someUserId = '00000000-0000-0000-0000-000000000000';

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ArticlesController],
      providers: [{ provide: ArticlesService, useValue: { importArticle } }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    importArticle.mockReset();
  });

  it('rejects an over-limit upload with 413 and never reaches the service', async () => {
    const overLimit = Buffer.alloc(maxImportBytes() + 1024, 0x61); // one KB past the cap
    const res = await request(app.getHttpServer())
      .post('/articles/import')
      .set('X-User-Id', someUserId)
      .field('categoryId', 'irrelevant')
      .attach('file', overLimit, 'big.md');

    expect(res.status).toBe(413);
    // The interceptor aborted before the handler — proof the whole file was not buffered.
    expect(importArticle).not.toHaveBeenCalled();
  });

  it('lets an under-limit upload reach the service handler', async () => {
    importArticle.mockResolvedValue({ id: 'a1' });
    const res = await request(app.getHttpServer())
      .post('/articles/import')
      .set('X-User-Id', someUserId)
      .field('categoryId', 'irrelevant')
      .attach('file', Buffer.from('# hello\n'), 'ok.md');

    expect(res.status).toBe(201);
    expect(importArticle).toHaveBeenCalledTimes(1);
  });
});

/**
 * The `status` / `categoryId` / `linked` / `linkedTo` list filters are validated against a
 * per-resource ALLOWLIST at the edge (ADR-0030 / ADR-0042): a recognized value is forwarded to the
 * service; an unknown value is rejected with 400, never silently ignored. `status` / `categoryId` /
 * `linkedTo` are **multi-select** (#198) — comma-encoded or repeated, parsed to a de-duplicated
 * array, each element validated. A single value still parses (backward-compat). Tested as a unit (the
 * method directly) — no guard/DB wiring.
 *
 * `findAll` positional args: (user, categoryId, authorId, status, q, linked, linkedTo, limit, …).
 */
describe('ArticlesController GET /articles (multi-select filters + allowlist, #198)', () => {
  const findPage = jest.fn().mockResolvedValue({ items: [], total: 0 });
  const controller = new ArticlesController({
    findPage,
  } as unknown as ArticlesService);

  beforeEach(() => findPage.mockClear());

  it('forwards a valid linked=only to the service', () => {
    void controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'only',
    );
    expect(findPage).toHaveBeenCalledTimes(1);
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ linked: 'only' }),
      expect.anything(),
      undefined,
    );
  });

  it('parses a single linkedTo=asset to a one-element array (backward-compat)', () => {
    void controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'asset',
    );
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTo: ['asset'] }),
      expect.anything(),
      undefined,
    );
  });

  it('comma-encodes multi-value linkedTo into a de-duplicated array (#198)', () => {
    void controller.findAll(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'asset,application,asset',
    );
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ linkedTo: ['asset', 'application'] }),
      expect.anything(),
      undefined,
    );
  });

  it('parses multi-value status into an array (#198)', () => {
    void controller.findAll(
      undefined,
      undefined,
      undefined,
      'DRAFT,PUBLISHED',
    );
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['DRAFT', 'PUBLISHED'] }),
      expect.anything(),
      undefined,
    );
  });

  it('accepts repeated params (string[]) for status (#198)', () => {
    void controller.findAll(
      undefined,
      undefined,
      undefined,
      ['DRAFT', 'PUBLISHED'],
    );
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ status: ['DRAFT', 'PUBLISHED'] }),
      expect.anything(),
      undefined,
    );
  });

  it('rejects an unknown linked value with 400 (never reaches the service)', () => {
    expect(() =>
      controller.findAll(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'yes',
      ),
    ).toThrow(BadRequestException);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('rejects an unknown element in a multi-value linkedTo with 400 (#198)', () => {
    expect(() =>
      controller.findAll(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'asset,database',
      ),
    ).toThrow(BadRequestException);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('rejects an unknown element in a multi-value status with 400 (#198)', () => {
    expect(() =>
      controller.findAll(undefined, undefined, undefined, 'DRAFT,ARCHIVED'),
    ).toThrow(BadRequestException);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('rejects a malformed cuid element in a multi-value categoryId with 400 (#198)', () => {
    expect(() =>
      controller.findAll(undefined, 'clh1abc0000xyz0000000abcd,not-a-cuid!'),
    ).toThrow(BadRequestException);
    expect(findPage).not.toHaveBeenCalled();
  });

  it('omits the link filter when neither param is present', () => {
    void controller.findAll(undefined);
    expect(findPage).toHaveBeenCalledWith(
      expect.objectContaining({ linked: undefined, linkedTo: undefined }),
      expect.anything(),
      undefined,
    );
  });
});
