import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
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
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

type DataCall = [{ data: Record<string, unknown> }];
type UpdateCall = [{ where: { id: string }; data: Record<string, unknown> }];

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
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ApplicationsService,
        { provide: PrismaService, useValue: { application } },
        { provide: SearchService, useValue: search },
      ],
    }).compile();

    service = moduleRef.get(ApplicationsService);
  });

  it('findAll excludes soft-deleted, ordered by name', async () => {
    application.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(application.findMany).toHaveBeenCalledWith({
      orderBy: { name: 'asc' },
    });
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
});
