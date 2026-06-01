import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));
// LocationsService transitively imports the ESM `meilisearch` package (via SearchService); jest
// can't transform it. SearchService is replaced by a mock below; this stub stops the real load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaLocationMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

describe('LocationsService', () => {
  let service: LocationsService;
  let location: PrismaLocationMock;
  let search: SearchMock;

  beforeEach(async () => {
    location = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    const prisma = {
      location,
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
      ],
    }).compile();

    service = moduleRef.get(LocationsService);
  });

  it('creates a location with only the required fields (name + type)', async () => {
    const dto = { name: 'HQ', type: 'OFFICE' as const };
    const created = {
      id: 'clh000000000000000000000',
      ...dto,
      description: null,
      address: null,
      floor: null,
      notes: null,
      deletedAt: null,
    };
    location.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(location.create).toHaveBeenCalledWith({ data: dto });
    // Fire-and-forget search sync (ADR-0035): the created location is upserted into `locations`.
    expect(search.upsert).toHaveBeenCalledWith('locations', {
      id: 'clh000000000000000000000',
      name: 'HQ',
      type: 'OFFICE',
      address: null,
      floor: null,
    });
  });

  it('creates a location with the optional fields populated', async () => {
    const dto = {
      name: 'Datacenter A',
      type: 'DATACENTER' as const,
      description: 'Primary datacenter',
      address: '123 Main St',
      floor: 'Subsuelo 1',
      notes: 'Restricted access',
    };
    const created = { id: 'clh000000000000000000001', ...dto, deletedAt: null };
    location.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(location.create).toHaveBeenCalledWith({ data: dto });
  });

  it('returns a location by id when it exists', async () => {
    const found = {
      id: 'clh000000000000000000000',
      name: 'HQ',
      deletedAt: null,
    };
    location.findFirst.mockResolvedValue(found);

    await expect(service.findOne('clh000000000000000000000')).resolves.toEqual(
      found,
    );
    expect(location.findFirst).toHaveBeenCalledWith({
      where: { id: 'clh000000000000000000000' },
    });
  });

  it('throws NotFound when the location does not exist', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies a partial update after confirming the location exists', async () => {
    location.findFirst.mockResolvedValue({ id: 'clh1', deletedAt: null });
    location.update.mockResolvedValue({ id: 'clh1', name: 'HQ renamed' });

    await service.update('clh1', { name: 'HQ renamed' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'clh1' },
      data: { name: 'HQ renamed' },
    });
    // Re-index the updated location (ADR-0035).
    expect(search.upsert).toHaveBeenCalledWith('locations', {
      id: 'clh1',
      name: 'HQ renamed',
      type: undefined,
      address: undefined,
      floor: undefined,
    });
  });

  it('does not update a location that is missing', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(location.update).not.toHaveBeenCalled();
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    location.findFirst.mockResolvedValue({ id: 'clh1', deletedAt: null });
    location.update.mockResolvedValue({ id: 'clh1', deletedAt: new Date() });

    await service.remove('clh1');

    // Soft delete = an UPDATE that stamps deletedAt, never a hard delete().
    expect(location.update).toHaveBeenCalledTimes(1);
    const calls = location.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'clh1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    // Soft-delete drops the location from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('locations', 'clh1');
  });

  it('does not soft-delete a location that is missing', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(location.update).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('findPage defaults to createdAt desc and returns the Page envelope', async () => {
    location.findMany.mockResolvedValue([{ id: 'loc1' }]);
    location.count.mockResolvedValue(1);

    const page = await service.findPage({}, { limit: 50, offset: 0 });

    expect(location.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
    });
    expect(page).toEqual({
      items: [{ id: 'loc1' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('findPage applies a case-insensitive q over name/address/floor/description', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage({ q: 'hq' }, { limit: 50, offset: 0 });

    const call = (
      location.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({
      OR: [
        { name: { contains: 'hq', mode: 'insensitive' } },
        { address: { contains: 'hq', mode: 'insensitive' } },
        { floor: { contains: 'hq', mode: 'insensitive' } },
        { description: { contains: 'hq', mode: 'insensitive' } },
      ],
    });
  });

  it('findPage honors an allowlisted sort and rejects an unknown one (400)', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'name', dir: 'asc' },
    );
    const call = (
      location.findMany.mock.calls as Array<
        [{ orderBy: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.orderBy).toEqual({ name: 'asc' });

    await expect(
      service.findPage({}, { limit: 50, offset: 0, sort: 'nope', dir: 'asc' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
