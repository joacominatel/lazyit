import { Test } from '@nestjs/testing';
import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
  // UsersService imports Role as a VALUE (Role.VIEWER) for the ADR-0043 create default, so the mock
  // must expose it or create() dereferences undefined.
  Role: { ADMIN: 'ADMIN', MEMBER: 'MEMBER', VIEWER: 'VIEWER' },
}));
// UsersService transitively imports the ESM `meilisearch` package (via SearchService); jest can't
// transform it. SearchService is replaced by a mock below; this stub stops the real module loading.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaUserMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
};

// The transaction client the offboarding writes go through; $transaction runs the callback with it.
type TxMock = {
  user: { update: jest.Mock };
  accessGrant: { updateMany: jest.Mock };
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

describe('UsersService', () => {
  let service: UsersService;
  let user: PrismaUserMock;
  let search: SearchMock;
  let tx: TxMock;
  let assignments: { releaseAllForUser: jest.Mock };

  beforeEach(async () => {
    user = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      // Default: there is at least one OTHER admin, so the last-admin guard is a no-op unless a test
      // overrides this to 0 to simulate the final administrator.
      count: jest.fn().mockResolvedValue(1),
    };
    tx = {
      user: { update: jest.fn() },
      accessGrant: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      user,
      // $transaction runs the callback with the tx client (synchronously resolved here).
      $transaction: jest.fn((cb: (client: TxMock) => unknown) => cb(tx)),
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // AssetAssignmentsService is mocked; its own logic is covered in its spec. Default: no active
    // assignments to release.
    assignments = { releaseAllForUser: jest.fn().mockResolvedValue([]) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
        { provide: AssetAssignmentsService, useValue: assignments },
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
      role: 'VIEWER',
      externalId: null,
      deletedAt: null,
    };
    user.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    // ADR-0043: an omitted role defaults to VIEWER (least-privilege), set explicitly by the service.
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'VIEWER' },
    });
    // Fire-and-forget search sync (ADR-0035): the created user is upserted into the `users` index.
    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-1',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'a@b.com',
    });
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('defaults an omitted role to VIEWER (ADR-0043 — uniform least-privilege default)', async () => {
    const dto = { email: 'v@b.com', firstName: 'Viv', lastName: 'Ian' };
    user.create.mockResolvedValue({ id: 'uuid-v', ...dto, role: 'VIEWER' });

    await service.create(dto);

    const createCalls = user.create.mock.calls as Array<
      [{ data: { role: string } }]
    >;
    expect(createCalls[0][0].data.role).toBe('VIEWER');
  });

  it('honours an explicit role on create (ADMIN-gated controller may pass any role)', async () => {
    const dto = {
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'ADMIN' as const,
    };
    user.create.mockResolvedValue({ id: 'uuid-a', ...dto });

    await service.create(dto);

    // An explicitly-supplied role is preserved (not overridden by the VIEWER default).
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'ADMIN' },
    });
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

  it('offboards: soft-deletes (deletedAt) + revokes grants + releases assignments, in one tx', async () => {
    user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });
    tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
    tx.accessGrant.updateMany.mockResolvedValue({ count: 2 });
    assignments.releaseAllForUser.mockResolvedValue([
      { id: 'assign-1', assetId: 'asset-1' },
    ]);

    const result = await service.remove('uuid-1', 'actor-99');

    // Soft delete = an UPDATE that stamps deletedAt, never a hard delete().
    expect(tx.user.update).toHaveBeenCalledTimes(1);
    const updateCalls = tx.user.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(updateCalls[0][0].where).toEqual({ id: 'uuid-1' });
    expect(updateCalls[0][0].data.deletedAt).toBeInstanceOf(Date);

    // Active grants are revoked inline (revokedAt + actor + audit note).
    const grantCalls = tx.accessGrant.updateMany.mock.calls as Array<
      [
        {
          where: { userId: string; revokedAt: null };
          data: { revokedAt: Date; revokedById?: string; notes: string };
        },
      ]
    >;
    expect(grantCalls[0][0].where).toEqual({
      userId: 'uuid-1',
      revokedAt: null,
    });
    expect(grantCalls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(grantCalls[0][0].data.revokedById).toBe('actor-99');
    expect(grantCalls[0][0].data.notes).toBe('auto: offboarded');

    // Active assignments are released through the bulk helper with the actor.
    expect(assignments.releaseAllForUser).toHaveBeenCalledWith(
      tx,
      'uuid-1',
      'actor-99',
    );

    // Soft-delete drops the user from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('users', 'uuid-1');

    // The offboarding summary is returned.
    expect(result).toEqual({
      userId: 'uuid-1',
      releasedAssignments: [{ id: 'assign-1', assetId: 'asset-1' }],
      revokedGrants: 2,
    });
  });

  it('does not offboard a user that is missing', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.accessGrant.updateMany).not.toHaveBeenCalled();
    expect(assignments.releaseAllForUser).not.toHaveBeenCalled();
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

  // ADR-0040 RBAC safety guards — last-admin protection + no self-role-change.
  describe('role-change guards (ADR-0040)', () => {
    it('forbids a user from changing their OWN role (403)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        role: 'ADMIN',
        deletedAt: null,
      });

      // actorId === target id → self-change is rejected before any DB write.
      await expect(
        service.update('uuid-1', { role: 'MEMBER' }, 'uuid-1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('refuses to demote the LAST remaining ADMIN (409)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      // No OTHER admin exists → this is the final administrator.
      user.count.mockResolvedValue(0);

      await expect(
        service.update('admin-1', { role: 'MEMBER' }, 'actor-99'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(user.count).toHaveBeenCalledWith({
        where: { role: 'ADMIN', id: { not: 'admin-1' } },
      });
      expect(user.update).not.toHaveBeenCalled();
    });

    it('allows demoting an admin when another admin remains', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(2); // other admins exist
      user.update.mockResolvedValue({
        id: 'admin-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
      });

      await expect(
        service.update('admin-1', { role: 'MEMBER' }, 'actor-99'),
      ).resolves.toMatchObject({ role: 'MEMBER' });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        data: { role: 'MEMBER' },
      });
    });

    it('allows promoting a member to admin without touching the last-admin guard', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        role: 'MEMBER',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'ADMIN',
      });

      await service.update('member-1', { role: 'ADMIN' }, 'actor-99');
      // Promotion is not a demotion-away-from-ADMIN, so the count guard never runs.
      expect(user.count).not.toHaveBeenCalled();
      expect(user.update).toHaveBeenCalled();
    });

    it('skips the guards for a non-role update (e.g. name change)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'admin-1',
        firstName: 'New',
        lastName: 'Name',
        email: 'a@b.com',
        role: 'ADMIN',
      });

      // Same actor as the target, but no role field → self-guard must NOT trip.
      await service.update('admin-1', { firstName: 'New' }, 'admin-1');
      expect(user.count).not.toHaveBeenCalled();
      expect(user.update).toHaveBeenCalled();
    });

    it('refuses to offboard the LAST remaining ADMIN (409)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(0); // the only admin

      await expect(
        service.remove('admin-1', 'actor-99'),
      ).rejects.toBeInstanceOf(ConflictException);
      // The transaction never runs — nothing is soft-deleted or revoked.
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.accessGrant.updateMany).not.toHaveBeenCalled();
    });

    it('offboards an admin when another admin remains', async () => {
      user.findFirst.mockResolvedValue({
        id: 'admin-1',
        role: 'ADMIN',
        deletedAt: null,
      });
      user.count.mockResolvedValue(1); // a second admin remains
      tx.user.update.mockResolvedValue({
        id: 'admin-1',
        deletedAt: new Date(),
      });

      await expect(
        service.remove('admin-1', 'actor-99'),
      ).resolves.toMatchObject({
        userId: 'admin-1',
      });
      expect(tx.user.update).toHaveBeenCalledTimes(1);
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
