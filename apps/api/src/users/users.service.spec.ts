import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaUserMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let user: PrismaUserMock;
  let search: SearchMock;

  beforeEach(async () => {
    user = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: { user } },
        { provide: SearchService, useValue: search },
      ],
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
    // Fire-and-forget search sync (ADR-0035): the created user is upserted into the `users` index.
    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'a@b.com',
    });
    expect(search.remove).not.toHaveBeenCalled();
  });

  // SEC-006: externalId is no longer a client-settable create field (it is server-owned, ADR-0016).
  // The schema-level guard is covered by packages/shared user.test.ts; the service just forwards the
  // (already-validated) payload to Prisma, asserted by the case above.

  it('returns a user by id when it exists', async () => {
    const found = { id: 'uuid-1', email: 'a@b.com', deletedAt: null };
    user.findFirst.mockResolvedValue(found);

    await expect(service.findOne('uuid-1')).resolves.toEqual(found);
    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
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
    // Soft-delete drops the user from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('users', 'uuid-1');
  });

  it('does not soft-delete a user that is missing', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(user.update).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('re-indexes the user on update (upsert with the updated row)', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    user.update.mockResolvedValue({
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Byron',
      email: 'a@b.com',
    });

    await service.update('uuid-1', { lastName: 'Byron' });

    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Byron',
      email: 'a@b.com',
    });
  });

  it('findAll excludes soft-deleted users', async () => {
    user.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(user.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
    });
  });
});
