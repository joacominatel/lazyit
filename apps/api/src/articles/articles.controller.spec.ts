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
 * The `linked` / `linkedTo` list filters are validated against a per-resource ALLOWLIST at the edge
 * (ADR-0030 / ADR-0042): a recognized value is forwarded to the service; an unknown value is rejected
 * with 400, never silently ignored. Tested as a unit (the method directly) — no guard/DB wiring.
 */
describe('ArticlesController GET /articles (linked filter allowlist)', () => {
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

  it('forwards a valid linkedTo=asset to the service', () => {
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
      expect.objectContaining({ linkedTo: 'asset' }),
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

  it('rejects an unknown linkedTo value with 400 (never reaches the service)', () => {
    expect(() =>
      controller.findAll(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'database',
      ),
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
