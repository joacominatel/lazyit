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

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(location.findMany).toHaveBeenCalledWith({
      // The default `active` slice scopes the list to live rows (ADR-0041).
      where: { deletedAt: null },
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

    await service.findPage(
      { q: 'hq' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

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
      deletedAt: null,
    });
  });

  it('findPage filters by type when set', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      { type: 'DATACENTER' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      location.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({ type: 'DATACENTER', deletedAt: null });
    // The count query must filter on the SAME where so total matches the page.
    const countCall = (
      location.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(countCall.where).toEqual({ type: 'DATACENTER', deletedAt: null });
  });

  it('findPage honors an allowlisted sort and rejects an unknown one (400)', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'name', dir: 'asc', deleted: 'active' },
    );
    const call = (
      location.findMany.mock.calls as Array<
        [{ orderBy: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.orderBy).toEqual({ name: 'asc' });

    await expect(
      service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'nope', dir: 'asc', deleted: 'active' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('findPage deleted=only returns soft-deleted rows via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
    location.findMany.mockResolvedValue([{ id: 'gone' }]);
    location.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'only' },
    );

    // The archived slice scopes to soft-deleted rows AND passes the ADR-0032 escape hatch so the
    // read filter doesn't re-hide them.
    expect(location.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      skip: 0,
      includeSoftDeleted: true,
    });
    expect(location.count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
    expect(page.items).toEqual([{ id: 'gone' }]);
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt for a soft-deleted location and re-indexes it', async () => {
    location.findFirst.mockResolvedValue({ id: 'loc1', deletedAt: new Date() });
    location.update.mockResolvedValue({ id: 'loc1', deletedAt: null });

    const restored = await service.restore('loc1');

    // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
    expect(location.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc1' },
      includeSoftDeleted: true,
    });
    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'loc1' },
      data: { deletedAt: null },
    });
    expect(restored.deletedAt).toBeNull();
    expect(search.upsert).toHaveBeenCalledWith('locations', expect.anything());
  });

  it('restore is idempotent (no update) when the location is already live', async () => {
    location.findFirst.mockResolvedValue({ id: 'loc1', deletedAt: null });

    await service.restore('loc1');

    expect(location.update).not.toHaveBeenCalled();
  });

  it('restore 404s when the location never existed', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- hierarchy / cycle prevention (#845) ---------------------------------

  // Drive findFirst off an in-memory tree so both findOne (existence) and the parent-walk resolve
  // against the same rows; unknown ids (or soft-deleted rows omitted from the map) return null.
  type Node = {
    id: string;
    name?: string;
    type?: string;
    parentId: string | null;
  };
  const seedTree = (nodes: Node[]) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    location.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        Promise.resolve(byId.get(where.id) ?? null),
    );
  };

  it('create sets a valid parent and rejects a missing/soft-deleted parent (400)', async () => {
    seedTree([{ id: 'root', parentId: null }]);
    location.create.mockResolvedValue({ id: 'child', parentId: 'root' });

    await expect(
      service.create({ name: 'Rack 1', type: 'RACK', parentId: 'root' }),
    ).resolves.toEqual({ id: 'child', parentId: 'root' });
    expect(location.create).toHaveBeenCalledWith({
      data: { name: 'Rack 1', type: 'RACK', parentId: 'root' },
    });

    // A parentId with no live row (never existed, or soft-deleted → filtered out) is rejected.
    location.create.mockClear();
    await expect(
      service.create({ name: 'Rack 2', type: 'RACK', parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(location.create).not.toHaveBeenCalled();
  });

  it('update rejects a location as its own parent (400)', async () => {
    seedTree([{ id: 'A', parentId: null }]);

    await expect(service.update('A', { parentId: 'A' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('update rejects re-parenting under a descendant — cycle (400)', async () => {
    // A → B → C. Moving A under C would close a loop (C is a descendant of A).
    seedTree([
      { id: 'A', parentId: null },
      { id: 'B', parentId: 'A' },
      { id: 'C', parentId: 'B' },
    ]);

    await expect(service.update('A', { parentId: 'C' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('update accepts a valid (non-cyclic) parent', async () => {
    seedTree([
      { id: 'root', parentId: null },
      { id: 'child', parentId: null },
    ]);
    location.update.mockResolvedValue({ id: 'child', parentId: 'root' });

    await service.update('child', { parentId: 'root' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'child' },
      data: { parentId: 'root' },
    });
  });

  it('update rejects a missing/soft-deleted parent (400)', async () => {
    seedTree([{ id: 'child', parentId: null }]);

    await expect(
      service.update('child', { parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(location.update).not.toHaveBeenCalled();
  });

  it('findOneWithAncestors resolves the path ordered root→self inclusive', async () => {
    seedTree([
      { id: 'site', name: 'HQ', type: 'OFFICE', parentId: null },
      { id: 'room', name: 'Server Room', type: 'DATACENTER', parentId: 'site' },
      { id: 'rack', name: 'Rack 1', type: 'RACK', parentId: 'room' },
    ]);

    const detail = await service.findOneWithAncestors('rack');

    expect(detail.id).toBe('rack');
    expect(detail.path).toEqual([
      { id: 'site', name: 'HQ', type: 'OFFICE' },
      { id: 'room', name: 'Server Room', type: 'DATACENTER' },
      { id: 'rack', name: 'Rack 1', type: 'RACK' },
    ]);
  });

  it('findOneWithAncestors returns a single-element path for a root location', async () => {
    seedTree([{ id: 'site', name: 'HQ', type: 'OFFICE', parentId: null }]);

    const detail = await service.findOneWithAncestors('site');

    expect(detail.path).toEqual([{ id: 'site', name: 'HQ', type: 'OFFICE' }]);
  });
});
