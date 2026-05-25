import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));

type PrismaUserMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

describe('UsersService', () => {
  let service: UsersService;
  let user: PrismaUserMock;

  beforeEach(async () => {
    user = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [UsersService, { provide: PrismaService, useValue: { user } }],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('creates a user without externalId (current case — no auth yet)', async () => {
    const dto = { email: 'a@b.com', firstName: 'Ada', lastName: 'Lovelace' };
    const created = {
      id: 'uuid-1',
      ...dto,
      isActive: true,
      externalId: null,
      deletedAt: null,
    };
    user.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(user.create).toHaveBeenCalledWith({ data: dto });
  });

  it('creates a user with externalId (future case — IdP sub mapping)', async () => {
    const dto = {
      email: 'b@c.com',
      firstName: 'Grace',
      lastName: 'Hopper',
      externalId: 'idp-sub-123',
    };
    const created = { id: 'uuid-2', ...dto, isActive: true, deletedAt: null };
    user.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(user.create).toHaveBeenCalledWith({ data: dto });
  });

  it('returns a user by id when it exists', async () => {
    const found = { id: 'uuid-1', email: 'a@b.com', deletedAt: null };
    user.findFirst.mockResolvedValue(found);

    await expect(service.findOne('uuid-1')).resolves.toEqual(found);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: 'uuid-1', deletedAt: null },
    });
  });

  it('throws NotFound when the user does not exist', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });

    await service.remove('uuid-1');

    // Soft delete = an UPDATE that stamps deletedAt, never a hard delete().
    expect(user.update).toHaveBeenCalledTimes(1);
    const calls = user.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'uuid-1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
  });

  it('does not soft-delete a user that is missing', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(user.update).not.toHaveBeenCalled();
  });

  it('findAll excludes soft-deleted users', async () => {
    user.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(user.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
  });
});
