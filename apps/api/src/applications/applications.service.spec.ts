import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for the InputJsonValue type (erased at runtime), so an empty object is enough.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
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

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

type DataCall = [{ data: Record<string, unknown> }];
type UpdateCall = [{ where: { id: string }; data: Record<string, unknown> }];
type FindManyCall = [
  { where?: Record<string, unknown>; orderBy?: Record<string, unknown> },
];

describe('ApplicationsService', () => {
  let service: ApplicationsService;
  let application: ApplicationMock;
  let search: SearchMock;

  beforeEach(async () => {
    application = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    // findPage runs [findMany, count] inside $transaction(array) — resolve each promise in the array.
    const prisma = {
      application,
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

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
    expect(calls[0][0].orderBy).toEqual({ name: 'asc' });
    // The default `active` slice scopes the list to live rows (ADR-0041).
    expect(calls[0][0].where).toEqual({ deletedAt: null });
    expect(page).toEqual({
      items: [{ id: 'app1' }],
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

  it('findPage honors an allowlisted sort field + dir', async () => {
    application.findMany.mockResolvedValue([]);
    application.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'vendor', dir: 'desc', deleted: 'active' },
    );

    const calls = application.findMany.mock.calls as FindManyCall[];
    expect(calls[0][0].orderBy).toEqual({ vendor: 'desc' });
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
    expect(page.items).toEqual([{ id: 'gone' }]);
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

  it('returns an application by id when it exists', async () => {
    const found = { id: 'app1', name: 'Jira', deletedAt: null };
    application.findFirst.mockResolvedValue(found);

    await expect(service.findOne('app1')).resolves.toEqual(found);
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
