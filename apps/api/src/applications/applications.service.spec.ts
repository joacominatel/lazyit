import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). `Prisma.DbNull` is
// the sentinel a `metadata: null` update writes to clear the jsonb column.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { DbNull: 'DbNull' },
}));
// ApplicationsService transitively imports the ESM `meilisearch` package (via SearchService); jest
// can't transform it. SearchService is replaced by a mock below; this stub stops the real load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type ApplicationMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

type AccessGrantMock = { findMany: jest.Mock };

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

type DataCall = [{ data: Record<string, unknown> }];
type UpdateCall = [{ where: { id: string }; data: Record<string, unknown> }];
type FindManyCall = [{ where?: Record<string, unknown>; orderBy?: unknown }];

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let application: ApplicationMock;
  let accessGrant: AccessGrantMock;
  let applicationCategory: { findFirst: jest.Mock };
  let search: SearchMock;
  // The category `FOR SHARE` lock create/update take (#1604): ids in `archivedCategories` come back archived.
  let queryRaw: jest.Mock;
  let archivedCategories: Set<string>;
  let transaction: jest.Mock;

  beforeEach(async () => {
    application = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    // Derived seatsUsed (#949) reads distinct active-grant (applicationId, userId) pairs. Default to an
    // empty set so the existing findOne/findPage cases just see 0 seats used.
    accessGrant = { findMany: jest.fn().mockResolvedValue([]) };
    applicationCategory = { findFirst: jest.fn() };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    archivedCategories = new Set();
    queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(
        strings.join('?').includes('FROM "application_categories"') &&
          !archivedCategories.has(values[0] as string)
          ? [{ id: values[0] }]
          : [],
      ),
    );
    // findPage runs [findMany, count] inside $transaction(array) — resolve each promise in the array; a write
    // passes a callback, run here against the same client.
    const prisma: Record<string, unknown> = {
      application,
      accessGrant,
      applicationCategory,
      $queryRaw: queryRaw,
    };
    transaction = jest.fn(
      (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) =>
        typeof arg === 'function' ? arg(prisma) : Promise.all(arg),
    );
    prisma.$transaction = transaction;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
      ],
    }).compile();

    service = moduleRef.get(ApplicationsService);
  });

  it('findPage defaults to name asc, scopes to live rows, and returns the Page envelope', async () => {
    application.findMany.mockResolvedValue([{ id: 'app1' }]);
    application.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    expect(calls[0][0].orderBy).toEqual([{ name: 'asc' }, { id: 'desc' }]);
    // The default `active` slice scopes the list to live rows (ADR-0041).
    expect(calls[0][0].where).toEqual({ deletedAt: null });
    // Each row carries the derived seatsUsed (#949) — 0 with no active grants.
    expect(page).toEqual({
      items: [{ id: 'app1', seatsUsed: 0 }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('findPage applies a case-insensitive q over name/vendor/url/description', async () => {
    application.findMany.mockResolvedValue([]);
    application.count.mockResolvedValue(0);

    await service.findPage(
      { q: 'jira' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'jira', mode: 'insensitive' } },
        { vendor: { contains: 'jira', mode: 'insensitive' } },
        { url: { contains: 'jira', mode: 'insensitive' } },
        { description: { contains: 'jira', mode: 'insensitive' } },
      ],
      deletedAt: null,
    });
  });

  it('findPage narrows by category and criticality alongside q, keeping isCritical=false', async () => {
    application.findMany.mockResolvedValue([]);
    application.count.mockResolvedValue(0);

    await service.findPage(
      { q: 'jira', categoryId: 'clcat0000000000000000001', isCritical: false },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    const countCalls = application.count.mock.calls as FindManyCall[];
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'jira', mode: 'insensitive' } },
        { vendor: { contains: 'jira', mode: 'insensitive' } },
        { url: { contains: 'jira', mode: 'insensitive' } },
        { description: { contains: 'jira', mode: 'insensitive' } },
      ],
      categoryId: 'clcat0000000000000000001',
      isCritical: false,
      deletedAt: null,
    });
    expect(countCalls[0][0].where).toEqual(calls[0][0].where);
  });

  it('findPage honors an allowlisted sort field + dir', async () => {
    application.findMany.mockResolvedValue([]);
    application.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'vendor', dir: 'desc', deleted: 'active' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    expect(calls[0][0].orderBy).toEqual([{ vendor: 'desc' }, { id: 'desc' }]);
  });

  it('findPage rejects an unknown sort field with 400', async () => {
    await expect(
      service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'secret', dir: 'asc', deleted: 'active' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(application.findMany).not.toHaveBeenCalled();
  });

  it('findPage deleted=only returns soft-deleted rows via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
    application.findMany.mockResolvedValue([{ id: 'gone' }]);
    application.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'only' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    expect(calls[0][0].where).toEqual({ deletedAt: { not: null } });
    expect(
      (calls[0][0] as unknown as { includeSoftDeleted?: boolean })
        .includeSoftDeleted,
    ).toBe(true);
    expect(page.items).toEqual([{ id: 'gone', seatsUsed: 0 }]);
  });

  it('creates an application (no metadata key when omitted)', async () => {
    application.create.mockResolvedValue({
      id: 'app1',
      name: 'Jira',
      vendor: 'Atlassian',
      description: null,
    });

    await service.create({ name: 'Jira', isCritical: true });

    const calls = application.create.mock.calls as DataCall[];
    expect(calls[0][0].data).toEqual({ name: 'Jira', isCritical: true });
    expect('metadata' in calls[0][0].data).toBe(false);
    // Fire-and-forget search sync (ADR-0035): the created application is upserted into the index.
    expect(search.upsert).toHaveBeenCalledWith('applications', {
      id: 'app1',
      name: 'Jira',
      vendor: 'Atlassian',
      description: null,
    });
  });

  it('passes metadata through to the create when provided', async () => {
    application.create.mockResolvedValue({ id: 'app1' });

    await service.create({
      name: 'AWS',
      isCritical: true,
      metadata: { ssoProvider: 'okta' },
    });

    const calls = application.create.mock.calls as DataCall[];
    expect(calls[0][0].data.metadata).toEqual({ ssoProvider: 'okta' });
  });

  it('returns an application by id when it exists (with derived seatsUsed)', async () => {
    const found = { id: 'app1', name: 'Jira', deletedAt: null };
    application.findFirst.mockResolvedValue(found);

    await expect(service.findOne('app1')).resolves.toEqual({
      ...found,
      seatsUsed: 0,
    });
    expect(application.findFirst).toHaveBeenCalledWith({
      where: { id: 'app1' },
    });
  });

  it('throws NotFound when the application does not exist', async () => {
    application.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- derived seatsUsed (#949, ADR-0088) ----------------------------------
  it('findOne seatsUsed is the DISTINCT active-grant user count (two active grants for one user = 1; revoked excluded)', async () => {
    application.findFirst.mockResolvedValue({ id: 'app1', deletedAt: null });
    // The DB `distinct: ['applicationId','userId']` collapses a user's two active grants to one pair,
    // so the query returns a single (app1, u1) row — exactly what the license math should count as 1.
    accessGrant.findMany.mockResolvedValue([
      { applicationId: 'app1', userId: 'u1' },
    ]);

    const result = await service.findOne('app1');

    expect(result.seatsUsed).toBe(1);
    // Revoked grants are excluded (revokedAt: null) and the multi-grant over-count is removed at the DB
    // via distinct — both encoded in this single query shape.
    expect(accessGrant.findMany).toHaveBeenCalledTimes(1);
    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { revokedAt: null, applicationId: { in: ['app1'] } },
      select: { applicationId: true, userId: true },
      distinct: ['applicationId', 'userId'],
    });
  });

  it('findPage folds distinct-user seat counts per app in ONE query (no per-row N+1)', async () => {
    application.findMany.mockResolvedValue([{ id: 'app1' }, { id: 'app2' }]);
    application.count.mockResolvedValue(2);
    // app1: two distinct users (u1, u2) → 2 seats; app2: one user (u1) → 1 seat.
    accessGrant.findMany.mockResolvedValue([
      { applicationId: 'app1', userId: 'u1' },
      { applicationId: 'app1', userId: 'u2' },
      { applicationId: 'app2', userId: 'u1' },
    ]);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(page.items).toEqual([
      { id: 'app1', seatsUsed: 2 },
      { id: 'app2', seatsUsed: 1 },
    ]);
    // A SINGLE grant query for the whole page (both ids in one `in` filter) — no per-row fan-out.
    expect(accessGrant.findMany).toHaveBeenCalledTimes(1);
    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { revokedAt: null, applicationId: { in: ['app1', 'app2'] } },
      select: { applicationId: true, userId: true },
      distinct: ['applicationId', 'userId'],
    });
  });

  it('findPage skips the seat query entirely for an empty page', async () => {
    application.findMany.mockResolvedValue([]);
    application.count.mockResolvedValue(0);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(page.items).toEqual([]);
    expect(accessGrant.findMany).not.toHaveBeenCalled();
  });

  it('applies a partial update after confirming the application exists', async () => {
    application.findFirst.mockResolvedValue({ id: 'app1', deletedAt: null });
    application.update.mockResolvedValue({ id: 'app1', vendor: 'Atlassian' });

    await service.update('app1', { vendor: 'Atlassian' });

    const calls = application.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'app1' });
    expect(calls[0][0].data).toEqual({ vendor: 'Atlassian' });
    // Re-index the updated application (ADR-0035).
    expect(search.upsert).toHaveBeenCalledWith('applications', {
      id: 'app1',
      name: undefined,
      vendor: 'Atlassian',
      description: undefined,
    });
  });

  // The category ids create/update locked FOR SHARE (#1604), in call order.
  const lockedCategories = () =>
    (queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][])
      .filter(([strings]) =>
        strings.join('?').includes('FROM "application_categories"'),
      )
      .map(([, id]) => id);

  describe('archived category on write (AUD-025, SEC-052)', () => {
    it('create refuses an archived or missing category with 400 and writes nothing', async () => {
      archivedCategories.add('cat1');

      await expect(
        service.create({ name: 'Jira', isCritical: false, categoryId: 'cat1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(lockedCategories()).toEqual(['cat1']);
      expect(application.create).not.toHaveBeenCalled();
    });

    it('create files under a live category', async () => {
      application.create.mockResolvedValue({ id: 'app1', categoryId: 'cat1' });

      await service.create({
        name: 'Jira',
        isCritical: false,
        categoryId: 'cat1',
      });

      const calls = application.create.mock.calls as DataCall[];
      expect(calls[0][0].data.categoryId).toBe('cat1');
    });

    it('update refuses moving to an archived category with 400 and writes nothing', async () => {
      application.findFirst.mockResolvedValue({ id: 'app1', categoryId: null });
      archivedCategories.add('archived');

      await expect(
        service.update('app1', { categoryId: 'archived' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(application.update).not.toHaveBeenCalled();
    });

    it('update keeps a legacy archived category without re-checking it', async () => {
      application.findFirst.mockResolvedValue({
        id: 'app1',
        categoryId: 'legacy',
      });
      archivedCategories.add('legacy');
      application.update.mockResolvedValue({ id: 'app1' });

      await service.update('app1', { categoryId: 'legacy', vendor: 'X' });

      expect(applicationCategory.findFirst).not.toHaveBeenCalled();
      expect(application.update).toHaveBeenCalled();
    });
  });

  // An application category delete locks the category FOR UPDATE before it moves the applications filed under
  // it; create and update hold it FOR SHARE until they commit (#1604).
  describe('the category a write names is locked FOR SHARE (#1604)', () => {
    it('create locks the category, with its liveness in the locking statement, before inserting — in one transaction', async () => {
      application.create.mockResolvedValue({ id: 'app1', categoryId: 'c1' });

      await service.create({
        name: 'Jira',
        isCritical: false,
        categoryId: 'c1',
      });

      expect(transaction).toHaveBeenCalledTimes(1);
      const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
      expect(strings.join('?')).toMatch(
        /FROM "application_categories"[\s\S]*"deletedAt" IS NULL[\s\S]*FOR SHARE/,
      );
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        application.create.mock.invocationCallOrder[0],
      );
    });

    it('create under a category a concurrent delete archived while it waited is a 400 — nothing written', async () => {
      archivedCategories.add('c1');

      await expect(
        service.create({ name: 'Jira', isCritical: false, categoryId: 'c1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(application.create).not.toHaveBeenCalled();
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('a re-categorisation locks the target category before reading or writing the application', async () => {
      application.findFirst.mockResolvedValue({ id: 'app1', categoryId: 'c0' });
      application.update.mockResolvedValue({ id: 'app1' });

      await service.update('app1', { categoryId: 'c1' });

      expect(lockedCategories()).toEqual(['c1']);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        application.findFirst.mock.invocationCallOrder[0],
      );
      expect(application.update).toHaveBeenCalledTimes(1);
    });

    it('a re-categorisation into a category archived while it waited is a 400 — nothing written', async () => {
      application.findFirst.mockResolvedValue({ id: 'app1', categoryId: 'c0' });
      archivedCategories.add('c1');

      await expect(
        service.update('app1', { categoryId: 'c1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(application.update).not.toHaveBeenCalled();
    });

    it("an update inside a caller's transaction (the license apply) runs on that client and opens none of its own", async () => {
      const caller = {
        application: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'app1', categoryId: 'c0' }),
          update: jest.fn().mockResolvedValue({ id: 'app1' }),
        },
        $queryRaw: jest.fn(),
      };

      await service.update('app1', { seatsPurchased: 10 }, caller as never);

      expect(transaction).not.toHaveBeenCalled();
      expect(caller.$queryRaw).not.toHaveBeenCalled();
      expect(caller.application.update).toHaveBeenCalledTimes(1);
      expect(application.update).not.toHaveBeenCalled();
    });
  });

  describe('clearing fields with null (AUD-084)', () => {
    it('detaches the category and clears the text fields', async () => {
      application.findFirst.mockResolvedValue({ id: 'app1', categoryId: 'c1' });
      application.update.mockResolvedValue({ id: 'app1' });

      await service.update('app1', {
        categoryId: null,
        description: null,
        url: null,
        vendor: null,
        notes: null,
      });

      expect(applicationCategory.findFirst).not.toHaveBeenCalled();
      const calls = application.update.mock.calls as UpdateCall[];
      expect(calls[0][0].data).toEqual({
        categoryId: null,
        description: null,
        url: null,
        vendor: null,
        notes: null,
      });
    });

    it('clears metadata to SQL NULL (Prisma.DbNull)', async () => {
      application.findFirst.mockResolvedValue({ id: 'app1', categoryId: null });
      application.update.mockResolvedValue({ id: 'app1' });

      await service.update('app1', { metadata: null });

      const calls = application.update.mock.calls as UpdateCall[];
      expect(calls[0][0].data).toEqual({ metadata: 'DbNull' });
    });
  });

  it('does not update a missing application', async () => {
    application.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { vendor: 'X' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(application.update).not.toHaveBeenCalled();
  });

  it('soft-deletes an application by setting deletedAt', async () => {
    application.findFirst.mockResolvedValue({ id: 'app1', deletedAt: null });
    application.update.mockResolvedValue({ id: 'app1', deletedAt: new Date() });

    await service.remove('app1');

    const calls = application.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'app1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    // Soft-delete drops the application from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('applications', 'app1');
  });

  it('does not soft-delete a missing application', async () => {
    application.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(application.update).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt for a soft-deleted application and re-indexes it', async () => {
    application.findFirst.mockResolvedValue({
      id: 'app1',
      deletedAt: new Date(),
    });
    application.update.mockResolvedValue({ id: 'app1', deletedAt: null });

    const restored = await service.restore('app1');

    // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
    expect(application.findFirst).toHaveBeenCalledWith({
      where: { id: 'app1' },
      includeSoftDeleted: true,
    });
    expect(application.update).toHaveBeenCalledWith({
      where: { id: 'app1' },
      data: { deletedAt: null },
    });
    expect(restored.deletedAt).toBeNull();
    expect(search.upsert).toHaveBeenCalledWith(
      'applications',
      expect.anything(),
    );
  });

  it('restore is idempotent (no update) when the application is already live', async () => {
    application.findFirst.mockResolvedValue({ id: 'app1', deletedAt: null });

    await service.restore('app1');

    expect(application.update).not.toHaveBeenCalled();
  });

  it('restore 404s when the application never existed', async () => {
    application.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
