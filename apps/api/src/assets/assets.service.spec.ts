import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type PrismaAssetMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

// The nested relations the expanded reads request. Mirrors ASSET_RELATIONS in the service: model
// (+category), location, and the active owners (releasedAt null) each with their user.
const EXPECTED_INCLUDE = {
  model: { include: { category: true } },
  location: true,
  assignments: {
    where: { releasedAt: null },
    orderBy: { assignedAt: 'desc' },
    include: { user: true },
  },
};

// A raw Prisma row as returned by findMany/findFirst with the include (before the service maps
// `assignments` -> `activeAssignments`). Overridable per test.
const rawRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'SRV-01',
  serial: null,
  assetTag: null,
  status: 'OPERATIONAL',
  specs: null,
  notes: null,
  purchaseDate: null,
  warrantyEnd: null,
  modelId: 'm1',
  locationId: 'l1',
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  model: { id: 'm1', name: 'Latitude', category: { id: 'c1', name: 'Laptop' } },
  location: { id: 'l1', name: 'HQ' },
  assignments: [
    {
      id: 'as1',
      assetId: 'a1',
      userId: 'u1',
      releasedAt: null,
      user: { id: 'u1' },
    },
  ],
  ...overrides,
});

describe('AssetsService', () => {
  let service: AssetsService;
  let asset: PrismaAssetMock;

  beforeEach(async () => {
    asset = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetsService,
        { provide: PrismaService, useValue: { asset } },
      ],
    }).compile();

    service = moduleRef.get(AssetsService);
  });

  // --- create (unchanged shape; writes stay lean) -------------------------
  it('creates an asset with specs and a purchase date (passed through)', async () => {
    const dto = {
      name: 'SRV-01',
      status: 'OPERATIONAL' as const,
      specs: { ram: '128GB' },
      purchaseDate: '2026-01-15T00:00:00.000Z',
    };
    asset.create.mockResolvedValue({ id: 'a1', ...dto });

    await service.create(dto);

    expect(asset.create).toHaveBeenCalledWith({ data: dto });
  });

  it('creates an asset without specs (no specs key sent to Prisma)', async () => {
    const dto = { name: 'SW-01', status: 'IN_STORAGE' as const };
    asset.create.mockResolvedValue({ id: 'a2', ...dto });

    await service.create(dto);

    const calls = asset.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0][0].data).not.toHaveProperty('specs');
    expect(calls[0][0].data).toEqual(dto);
  });

  // --- findOne (expanded) -------------------------------------------------
  it('findOne queries with the relations include + soft-delete filter', async () => {
    asset.findFirst.mockResolvedValue(rawRow());

    await service.findOne('a1');

    expect(asset.findFirst).toHaveBeenCalledWith({
      where: { id: 'a1' },
      include: EXPECTED_INCLUDE,
    });
  });

  it('findOne maps assignments -> activeAssignments and inlines model/category/location', async () => {
    asset.findFirst.mockResolvedValue(rawRow());

    const result = await service.findOne('a1');

    expect(result).not.toHaveProperty('assignments');
    expect(result.activeAssignments).toEqual([
      {
        id: 'as1',
        assetId: 'a1',
        userId: 'u1',
        releasedAt: null,
        user: { id: 'u1' },
      },
    ]);
    expect(result.model).toEqual({
      id: 'm1',
      name: 'Latitude',
      category: { id: 'c1', name: 'Laptop' },
    });
    expect(result.location).toEqual({ id: 'l1', name: 'HQ' });
  });

  it('findOne passes nulls/empties through: model null, location null, no active assignments', async () => {
    asset.findFirst.mockResolvedValue(
      rawRow({ model: null, location: null, assignments: [] }),
    );

    const result = await service.findOne('a1');

    expect(result.model).toBeNull();
    expect(result.location).toBeNull();
    expect(result.activeAssignments).toEqual([]);
  });

  it('findOne returns model.category = null when the model has no category', async () => {
    asset.findFirst.mockResolvedValue(
      rawRow({ model: { id: 'm1', name: 'Generic', category: null } }),
    );

    const result = await service.findOne('a1');

    expect(result.model).toEqual({ id: 'm1', name: 'Generic', category: null });
  });

  it('findOne throws NotFound when the asset does not exist', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- findAll (expanded) -------------------------------------------------
  it('findAll without filters: excludes soft-deleted, newest first, with relations', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(asset.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: 'desc' },
      include: EXPECTED_INCLUDE,
    });
  });

  it('findAll maps each row assignments -> activeAssignments', async () => {
    asset.findMany.mockResolvedValue([
      rawRow({
        assignments: [
          { id: 'as1', releasedAt: null, user: { id: 'u1' } },
          { id: 'as2', releasedAt: null, user: { id: 'u2' } },
        ],
      }),
    ]);

    const result = await service.findAll();

    expect(result[0]).not.toHaveProperty('assignments');
    expect(result[0].activeAssignments).toHaveLength(2);
  });

  it('the assignments include filters to active (releasedAt null) so released owners are excluded', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll();

    const calls = asset.findMany.mock.calls as Array<
      [{ include: { assignments: { where: unknown } } }]
    >;
    expect(calls[0][0].include.assignments.where).toEqual({ releasedAt: null });
  });

  it('findAll filters by status and locationId', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll({ status: 'RETIRED', locationId: 'l1' });

    expect(asset.findMany).toHaveBeenCalledWith({
      where: { locationId: 'l1', status: 'RETIRED' },
      orderBy: { createdAt: 'desc' },
      include: EXPECTED_INCLUDE,
    });
  });

  it('findAll filters by categoryId through the related model', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll({ categoryId: 'c1' });

    expect(asset.findMany).toHaveBeenCalledWith({
      where: { model: { categoryId: 'c1' } },
      orderBy: { createdAt: 'desc' },
      include: EXPECTED_INCLUDE,
    });
  });

  it('findAll filters by q (case-insensitive OR over name/serial/assetTag)', async () => {
    asset.findMany.mockResolvedValue([]);

    await service.findAll({ q: 'srv' });

    const calls = asset.findMany.mock.calls as Array<
      [{ where: Record<string, unknown> }]
    >;
    expect(calls[0][0].where).toEqual({
      OR: [
        { name: { contains: 'srv', mode: 'insensitive' } },
        { serial: { contains: 'srv', mode: 'insensitive' } },
        { assetTag: { contains: 'srv', mode: 'insensitive' } },
      ],
    });
  });

  // --- update / remove (lean; assertExists guards 404) --------------------
  it('applies a partial update after confirming the asset exists', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    asset.update.mockResolvedValue({ id: 'a1', status: 'RETIRED' });

    await service.update('a1', { status: 'RETIRED' });

    expect(asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED' },
    });
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    asset.findFirst.mockResolvedValue({ id: 'a1' });
    asset.update.mockResolvedValue({ id: 'a1', deletedAt: new Date() });

    await service.remove('a1');

    expect(asset.update).toHaveBeenCalledTimes(1);
    const calls = asset.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'a1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete an asset that is missing', async () => {
    asset.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(asset.update).not.toHaveBeenCalled();
  });
});
