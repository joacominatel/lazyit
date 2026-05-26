import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { LocationsService } from './locations.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

type PrismaLocationMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

describe('LocationsService', () => {
  let service: LocationsService;
  let location: PrismaLocationMock;

  beforeEach(async () => {
    location = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: { location } },
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

    await expect(
      service.findOne('clh000000000000000000000'),
    ).resolves.toEqual(found);
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
  });

  it('does not soft-delete a location that is missing', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('findAll excludes soft-deleted locations', async () => {
    location.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(location.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });
});
