import { BadRequestException } from '@nestjs/common';

// Importing the real AssetsController transitively loads the generated Prisma client (via its
// services) — jest can't resolve its internal modules, so stub it (no DB; the services are mocked
// below). meilisearch is ESM (pulled in via ArticlesService → SearchService); stub it too.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { AssetsController } from './assets.controller';
import type { AssetsService } from './assets.service';
import type { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import type { AssetHistoryService } from '../asset-history/asset-history.service';
import type { ArticlesService } from '../articles/articles.service';

/**
 * Reverse KB lookup on the asset detail surface (`GET /assets/:id/articles`, #220): the endpoint is
 * now paginated + filterable. Unit tests instantiate the controller with mocked services and call
 * `findArticles` directly (no guard/DB wiring — same style as articles.controller.spec.ts). They
 * assert the 404 existence guard (`assets.assertExists`) runs before the read, that valid
 * `q`/`status`/`categoryId` filters + the page window are forwarded, and that an unknown filter
 * element (or an over-max limit) is rejected with 400 and never reaches the service.
 */
describe('AssetsController GET /assets/:id/articles (paginated + filtered, #220)', () => {
  const assertExists = jest.fn().mockResolvedValue(undefined);
  const findArticlesForAsset = jest
    .fn()
    .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

  const controller = new AssetsController(
    { assertExists } as unknown as AssetsService,
    {} as unknown as AssetAssignmentsService,
    {} as unknown as AssetHistoryService,
    { findArticlesForAsset } as unknown as ArticlesService,
  );

  beforeEach(() => {
    assertExists.mockClear();
    findArticlesForAsset.mockClear();
  });

  it('guards existence (assertExists) before reading, then forwards filters + the page window + the caller principal (#553)', async () => {
    // The caller principal is threaded through so the reverse list is folder-access-pinned (ADR-0060
    // §4 / INV-9 — #553); the controller forwards it as the 4th arg to the service.
    const principal = { kind: 'human', user: { id: 'u1' } } as never;
    await controller.findArticles(
      'as1',
      'router',
      'PUBLISHED',
      'clh1abc0000xyz0000000abcd',
      '25',
      '50',
      undefined,
      principal,
    );
    expect(assertExists).toHaveBeenCalledWith('as1');
    expect(findArticlesForAsset).toHaveBeenCalledTimes(1);
    expect(findArticlesForAsset).toHaveBeenCalledWith(
      'as1',
      {
        q: 'router',
        status: ['PUBLISHED'],
        categoryId: ['clh1abc0000xyz0000000abcd'],
      },
      expect.objectContaining({ limit: 25, offset: 50 }),
      principal,
    );
  });

  it('rejects an unknown status element with 400 (never reaches the service)', async () => {
    await expect(
      controller.findArticles('as1', undefined, 'DRAFT,ARCHIVED'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForAsset).not.toHaveBeenCalled();
  });

  it('rejects a malformed categoryId element with 400 (never reaches the service)', async () => {
    await expect(
      controller.findArticles(
        'as1',
        undefined,
        undefined,
        'clh1abc0000xyz0000000abcd,not-a-cuid!',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForAsset).not.toHaveBeenCalled();
  });

  it('rejects an over-max limit with 400 (rejected, not clamped — ADR-0030)', async () => {
    await expect(
      controller.findArticles('as1', undefined, undefined, undefined, '201'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForAsset).not.toHaveBeenCalled();
  });
});
