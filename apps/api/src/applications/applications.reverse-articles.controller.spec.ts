import { BadRequestException } from '@nestjs/common';

// Importing the real ApplicationsController transitively loads the generated Prisma client (via its
// services) — jest can't resolve its internal modules, so stub it (no DB; the services are mocked
// below). meilisearch is ESM (pulled in via ArticlesService → SearchService); stub it too.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import { ApplicationsController } from './applications.controller';
import type { ApplicationsService } from './applications.service';
import type { AccessGrantsService } from '../access-grants/access-grants.service';
import type { ArticlesService } from '../articles/articles.service';

/**
 * Reverse KB lookup on the application detail surface (`GET /applications/:id/articles`, #220): the
 * endpoint is now paginated + filterable. These unit tests instantiate the controller with mocked
 * services and call `findArticles` directly (no guard/DB wiring — the same style as
 * articles.controller.spec.ts). They assert that:
 *   - the 404 existence guard (`applications.findOne`) runs before the service read;
 *   - valid `q`/`status`/`categoryId` multi-select filters + the page window are forwarded;
 *   - an unknown filter element (status / categoryId) is rejected with 400 and never reaches the
 *     service (the PUBLISHED-only privacy + the `Page<T>` shape are covered in articles.service.spec.ts).
 */
describe('ApplicationsController GET /applications/:id/articles (paginated + filtered, #220)', () => {
  const findOne = jest.fn().mockResolvedValue({ id: 'app1' });
  const findArticlesForApplication = jest
    .fn()
    .mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 });

  const controller = new ApplicationsController(
    { findOne } as unknown as ApplicationsService,
    {} as unknown as AccessGrantsService,
    { findArticlesForApplication } as unknown as ArticlesService,
  );

  beforeEach(() => {
    findOne.mockClear();
    findArticlesForApplication.mockClear();
  });

  it('guards existence (findOne) before reading, then forwards filters + the page window + the caller principal (#553)', async () => {
    // The caller principal is threaded through so the reverse list is folder-access-pinned (ADR-0060
    // §4 / INV-9 — #553); the controller forwards it as the 4th arg to the service.
    const principal = { kind: 'human', user: { id: 'u1' } } as never;
    await controller.findArticles(
      'app1',
      'vpn',
      'PUBLISHED',
      'clh1abc0000xyz0000000abcd',
      '10',
      '20',
      undefined,
      principal,
    );
    expect(findOne).toHaveBeenCalledWith('app1');
    expect(findArticlesForApplication).toHaveBeenCalledTimes(1);
    expect(findArticlesForApplication).toHaveBeenCalledWith(
      'app1',
      {
        q: 'vpn',
        status: ['PUBLISHED'],
        categoryId: ['clh1abc0000xyz0000000abcd'],
      },
      expect.objectContaining({ limit: 10, offset: 20 }),
      principal,
    );
  });

  it('parses multi-value status / categoryId (comma-encoded → de-duplicated arrays, #198)', async () => {
    await controller.findArticles(
      'app1',
      undefined,
      'DRAFT,PUBLISHED',
      'clh1abc0000xyz0000000abcd,clh2abc0000xyz0000000abcd',
    );
    expect(findArticlesForApplication).toHaveBeenCalledWith(
      'app1',
      expect.objectContaining({
        status: ['DRAFT', 'PUBLISHED'],
        categoryId: [
          'clh1abc0000xyz0000000abcd',
          'clh2abc0000xyz0000000abcd',
        ],
      }),
      expect.anything(),
      // No principal passed in this call → forwarded as undefined (folder pin resolves to the
      // fail-closed / public set in the service).
      undefined,
    );
  });

  it('rejects an unknown status element with 400 (never reaches the service)', async () => {
    await expect(
      controller.findArticles('app1', undefined, 'DRAFT,ARCHIVED'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForApplication).not.toHaveBeenCalled();
  });

  it('rejects a malformed categoryId element with 400 (never reaches the service)', async () => {
    await expect(
      controller.findArticles(
        'app1',
        undefined,
        undefined,
        'clh1abc0000xyz0000000abcd,not-a-cuid!',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForApplication).not.toHaveBeenCalled();
  });

  it('rejects an over-max limit with 400 (rejected, not clamped — ADR-0030)', async () => {
    await expect(
      controller.findArticles(
        'app1',
        undefined,
        undefined,
        undefined,
        '201',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(findArticlesForApplication).not.toHaveBeenCalled();
  });
});
