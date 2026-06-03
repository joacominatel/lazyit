import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getLoggerToken, PinoLogger } from 'nestjs-pino';
import { UsersService } from './users.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import {
  IDENTITY_PROVIDER,
  PasswordResetUnsupportedError,
} from '../auth/identity/identity-provider.interface';
import type { IdentityProvider } from '../auth/identity/identity-provider.interface';

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
  delete: jest.Mock;
  count: jest.Mock;
};

// A mock IdentityProvider (ADR-0043 write-back). Defaults to a supports-management provider whose
// calls resolve; individual tests override a method to reject to exercise the no-split-brain paths.
type IdpMock = {
  kind: string;
  supportsManagement: boolean;
  resolveExternalRef: jest.Mock;
  createUser: jest.Mock;
  deactivateUser: jest.Mock;
  grantRole: jest.Mock;
  revokeRole: jest.Mock;
  // Issue #149: profile (name/email) write-back + password-reset trigger.
  updateUser: jest.Mock;
  requestPasswordReset: jest.Mock;
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
  let idp: IdpMock;

  beforeEach(async () => {
    user = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
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
      // Handles BOTH forms: callback (offboard) with the tx client, and array (findPage's
      // [findMany, count]) which resolves each promise in the array.
      $transaction: jest.fn(
        (arg: ((client: TxMock) => unknown) | Promise<unknown>[]) =>
          Array.isArray(arg) ? Promise.all(arg) : arg(tx),
      ),
    };
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };
    // AssetAssignmentsService is mocked; its own logic is covered in its spec. Default: no active
    // assignments to release.
    assignments = { releaseAllForUser: jest.fn().mockResolvedValue([]) };
    // Default IdP: a supports-management provider whose write-backs succeed. createUser echoes a
    // distinct externalId so the create path's externalId-link branch is exercised. Tests that probe
    // the no-split-brain compensation override a method to reject.
    idp = {
      kind: 'zitadel',
      supportsManagement: true,
      resolveExternalRef: jest.fn((sub: string) =>
        Promise.resolve({ externalId: sub }),
      ),
      createUser: jest.fn().mockResolvedValue({ externalId: 'zitadel-user-1' }),
      deactivateUser: jest.fn().mockResolvedValue(undefined),
      grantRole: jest.fn().mockResolvedValue(undefined),
      revokeRole: jest.fn().mockResolvedValue(undefined),
      // Issue #149: default to a supports-management provider whose profile write-back + reset succeed.
      updateUser: jest.fn().mockResolvedValue(undefined),
      requestPasswordReset: jest.fn().mockResolvedValue(undefined),
    };
    // A no-op PinoLogger stand-in (the service uses it for structured write-back audit lines).
    const logger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as PinoLogger;

    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
        { provide: AssetAssignmentsService, useValue: assignments },
        { provide: IDENTITY_PROVIDER, useValue: idp as IdentityProvider },
        { provide: getLoggerToken(UsersService.name), useValue: logger },
      ],
    }).compile();

    service = moduleRef.get(UsersService);
  });

  it('creates the local mirror then links the Zitadel externalId (ADR-0043 §3 DB-first + mirror)', async () => {
    const dto = { email: 'a@b.com', firstName: 'Ada', lastName: 'Lovelace' };
    const created = {
      id: 'uuid-1',
      ...dto,
      isActive: true,
      role: 'VIEWER',
      externalId: null,
      deletedAt: null,
    };
    const linked = { ...created, externalId: 'zitadel-user-1' };
    user.create.mockResolvedValue(created);
    user.update.mockResolvedValue(linked);

    // The default idp supportsManagement and returns externalId 'zitadel-user-1'.
    await expect(service.create(dto)).resolves.toEqual(linked);
    // ADR-0043: an omitted role defaults to VIEWER (least-privilege), set explicitly by the service.
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'VIEWER' },
    });
    // The IdP mirror is invoked with the new user's profile + resolved role.
    expect(idp.createUser).toHaveBeenCalledWith({
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'VIEWER',
    });
    // The Zitadel user id is persisted back onto the local row as externalId.
    expect(user.update).toHaveBeenCalledWith({
      where: { id: 'uuid-1' },
      data: { externalId: 'zitadel-user-1' },
    });
    // Fire-and-forget search sync (ADR-0035): the linked user is upserted into the `users` index.
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
    user.update.mockResolvedValue({
      id: 'uuid-v',
      ...dto,
      role: 'VIEWER',
      externalId: 'zitadel-user-1',
    });

    await service.create(dto);

    const createCalls = user.create.mock.calls as Array<
      [{ data: { role: string } }]
    >;
    expect(createCalls[0][0].data.role).toBe('VIEWER');
    // The mirror also receives the VIEWER role.
    expect(idp.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'VIEWER' }),
    );
  });

  it('honours an explicit role on create (ADMIN-gated controller may pass any role)', async () => {
    const dto = {
      email: 'a@b.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      role: 'ADMIN' as const,
    };
    user.create.mockResolvedValue({ id: 'uuid-a', ...dto });
    user.update.mockResolvedValue({
      id: 'uuid-a',
      ...dto,
      externalId: 'zitadel-user-1',
    });

    await service.create(dto);

    // An explicitly-supplied role is preserved (not overridden by the VIEWER default).
    expect(user.create).toHaveBeenCalledWith({
      data: { ...dto, role: 'ADMIN' },
    });
    expect(idp.createUser).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN' }),
    );
  });

  it('BYOI (generic-oidc): creates the LOCAL user, no externalId link, no 503', async () => {
    // BYOI provider: supportsManagement=false, createUser no-ops returning an empty ref.
    idp.supportsManagement = false;
    idp.createUser.mockResolvedValue({ externalId: '' });
    const dto = { email: 'b@b.com', firstName: 'By', lastName: 'Oi' };
    const created = {
      id: 'uuid-b',
      ...dto,
      role: 'VIEWER',
      externalId: null,
      deletedAt: null,
    };
    user.create.mockResolvedValue(created);

    // The local create succeeds and is returned as-is; no externalId-link update; no throw.
    await expect(service.create(dto)).resolves.toEqual(created);
    expect(user.update).not.toHaveBeenCalled();
    expect(user.delete).not.toHaveBeenCalled();
    expect(search.upsert).toHaveBeenCalledWith('users', {
      id: 'uuid-b',
      firstName: 'By',
      lastName: 'Oi',
      email: 'b@b.com',
    });
  });

  it('no-split-brain: an IdP createUser failure rolls back the local user and surfaces 503', async () => {
    const dto = { email: 'c@b.com', firstName: 'Caro', lastName: 'Line' };
    user.create.mockResolvedValue({
      id: 'uuid-c',
      ...dto,
      role: 'VIEWER',
      externalId: null,
    });
    // The Management mirror fails — the upstream contract surfaces this as 503.
    idp.createUser.mockRejectedValue(
      new ServiceUnavailableException('Zitadel management call failed'),
    );

    await expect(service.create(dto)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // Compensation: the just-created local row is HARD-deleted so local + Zitadel never disagree.
    expect(user.delete).toHaveBeenCalledWith({ where: { id: 'uuid-c' } });
    // No externalId link, and the user is not left indexed for search.
    expect(user.update).not.toHaveBeenCalled();
    expect(search.upsert).not.toHaveBeenCalled();
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

    const result = await service.remove('uuid-1', { userId: 'actor-99' });

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
          data: {
            revokedAt: Date;
            revokedById?: string;
            revokedBySaId?: string;
            notes: string;
          };
        },
      ]
    >;
    expect(grantCalls[0][0].where).toEqual({
      userId: 'uuid-1',
      revokedAt: null,
    });
    expect(grantCalls[0][0].data.revokedAt).toBeInstanceOf(Date);
    // A human offboarder → revokedById, never revokedBySaId (behavior-preserving; ADR-0048).
    expect(grantCalls[0][0].data.revokedById).toBe('actor-99');
    expect(grantCalls[0][0].data).not.toHaveProperty('revokedBySaId');
    expect(grantCalls[0][0].data.notes).toBe('auto: offboarded');

    // Active assignments are released through the bulk helper with the resolved attribution.
    expect(assignments.releaseAllForUser).toHaveBeenCalledWith(tx, 'uuid-1', {
      userId: 'actor-99',
    });

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
        service.remove('admin-1', { userId: 'actor-99' }),
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
        service.remove('admin-1', { userId: 'actor-99' }),
      ).resolves.toMatchObject({
        userId: 'admin-1',
      });
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('findPage', () => {
    it('defaults to createdAt desc, scopes to live users, and returns the Page envelope', async () => {
      user.findMany.mockResolvedValue([{ id: 'u1' }]);
      user.count.mockResolvedValue(1);

      const page = await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'active' },
      );

      expect(user.findMany).toHaveBeenCalledWith({
        // The default `active` slice scopes the list to live users (ADR-0041).
        where: { deletedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 50,
        skip: 0,
      });
      expect(page).toEqual({
        items: [{ id: 'u1' }],
        total: 1,
        limit: 50,
        offset: 0,
      });
    });

    it('applies a case-insensitive q over firstName/lastName/email', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        { q: 'bob' },
        { limit: 50, offset: 0, deleted: 'active' },
      );

      const call = (
        user.findMany.mock.calls as Array<[{ where: Record<string, unknown> }]>
      )[0][0];
      expect(call.where).toEqual({
        OR: [
          { firstName: { contains: 'bob', mode: 'insensitive' } },
          { lastName: { contains: 'bob', mode: 'insensitive' } },
          { email: { contains: 'bob', mode: 'insensitive' } },
        ],
        deletedAt: null,
      });
    });

    it('honors an allowlisted sort and rejects an unknown one (400)', async () => {
      user.findMany.mockResolvedValue([]);
      user.count.mockResolvedValue(0);

      await service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'email', dir: 'asc', deleted: 'active' },
      );
      const call = (
        user.findMany.mock.calls as Array<
          [{ orderBy: Record<string, unknown> }]
        >
      )[0][0];
      expect(call.orderBy).toEqual({ email: 'asc' });

      await expect(
        service.findPage(
          {},
          {
            limit: 50,
            offset: 0,
            sort: 'password',
            dir: 'asc',
            deleted: 'active',
          },
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('deleted=only returns soft-deleted (offboarded) users via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
      user.findMany.mockResolvedValue([{ id: 'gone' }]);
      user.count.mockResolvedValue(1);

      const page = await service.findPage(
        {},
        { limit: 50, offset: 0, deleted: 'only' },
      );

      expect(user.findMany).toHaveBeenCalledWith({
        where: { deletedAt: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        skip: 0,
        includeSoftDeleted: true,
      });
      expect(user.count).toHaveBeenCalledWith({
        where: { deletedAt: { not: null } },
        includeSoftDeleted: true,
      });
      expect(page.items).toEqual([{ id: 'gone' }]);
    });
  });

  // ADR-0043 §3 — IdP write-back (DB-first + mirror), no-split-brain, 503 on Management failure.
  describe('IdP write-back (ADR-0043 §3)', () => {
    it('role change on a linked user mirrors grantRole to the IdP', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'ADMIN',
        externalId: 'zitadel-user-9',
      });

      await service.update('member-1', { role: 'ADMIN' }, 'actor-99');

      expect(idp.grantRole).toHaveBeenCalledWith('zitadel-user-9', 'ADMIN');
    });

    it('a non-role update never touches the IdP (no grant call)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'New',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
      });

      await service.update('member-1', { firstName: 'New' }, 'actor-99');

      expect(idp.grantRole).not.toHaveBeenCalled();
    });

    it('a local-only user (no externalId) skips the grant mirror on role change', async () => {
      user.findFirst.mockResolvedValue({
        id: 'local-1',
        role: 'MEMBER',
        externalId: null,
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'local-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'ADMIN',
        externalId: null,
      });

      await service.update('local-1', { role: 'ADMIN' }, 'actor-99');

      expect(idp.grantRole).not.toHaveBeenCalled();
    });

    it('no-split-brain: a grantRole failure reverts the local role and surfaces 503', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      // First update applies the new role; the revert update restores the previous role.
      user.update
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'A',
          lastName: 'B',
          email: 'a@b.com',
          role: 'ADMIN',
          externalId: 'zitadel-user-9',
        })
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'A',
          lastName: 'B',
          email: 'a@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        });
      idp.grantRole.mockRejectedValue(
        new ServiceUnavailableException('Zitadel management call failed'),
      );

      await expect(
        service.update('member-1', { role: 'ADMIN' }, 'actor-99'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The local role is reverted to MEMBER (the truth) so local + Zitadel agree. A role-only change
      // reverts ONLY the role (issue #149: the revert is scoped to the fields that actually changed).
      const updateCalls = user.update.mock.calls as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(updateCalls[1][0]).toEqual({
        where: { id: 'member-1' },
        data: { role: 'MEMBER' },
      });
    });

    // --- Issue #149: name/email profile write-back + password-reset trigger ----------------------
    it('name change on a linked user mirrors updateUser to the IdP (no role grant)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'Old',
        lastName: 'Name',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'New',
        lastName: 'Name',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
      });

      await service.update(
        'member-1',
        { firstName: 'New', lastName: 'Name' },
        'actor-99',
      );

      // Only the changed name field is pushed (lastName resent unchanged is omitted); externalId stays.
      expect(idp.updateUser).toHaveBeenCalledWith('zitadel-user-9', {
        firstName: 'New',
      });
      expect(idp.grantRole).not.toHaveBeenCalled();
    });

    it('email change on a linked user mirrors updateUser + updates the local citext row', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'new@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
      });

      await service.update('member-1', { email: 'new@b.com' }, 'actor-99');

      // The local row is updated with the new (already-normalized) email.
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'member-1' },
        data: { email: 'new@b.com' },
      });
      // The same externalId (sub) is reused — an update, never a re-link (SEC-006).
      expect(idp.updateUser).toHaveBeenCalledWith('zitadel-user-9', {
        email: 'new@b.com',
      });
    });

    it('a local-only user (no externalId) skips the profile mirror on name/email change', async () => {
      user.findFirst.mockResolvedValue({
        id: 'local-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        externalId: null,
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'local-1',
        firstName: 'A',
        lastName: 'B',
        email: 'new@b.com',
        role: 'MEMBER',
        externalId: null,
      });

      await service.update('local-1', { email: 'new@b.com' }, 'actor-99');

      expect(idp.updateUser).not.toHaveBeenCalled();
    });

    it('resending the same name/email does NOT call the IdP (no needless round-trip)', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update.mockResolvedValue({
        id: 'member-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
      });

      await service.update(
        'member-1',
        { firstName: 'A', email: 'a@b.com' },
        'actor-99',
      );

      expect(idp.updateUser).not.toHaveBeenCalled();
      expect(idp.grantRole).not.toHaveBeenCalled();
    });

    it('no-split-brain: an updateUser failure reverts the local row (role+name+email) and surfaces 503', async () => {
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'Old',
        lastName: 'Name',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'New',
          lastName: 'Name',
          email: 'new@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        })
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'Old',
          lastName: 'Name',
          email: 'old@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        });
      idp.updateUser.mockRejectedValue(
        new ServiceUnavailableException('Zitadel management call failed'),
      );

      await expect(
        service.update(
          'member-1',
          { firstName: 'New', email: 'new@b.com' },
          'actor-99',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      const updateCalls = user.update.mock.calls as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      // The compensating revert restores ONLY the changed fields' prior values (name + email here; no
      // role, since the role did not change) — no split-brain, no touching untouched columns.
      expect(updateCalls[1][0]).toEqual({
        where: { id: 'member-1' },
        data: {
          firstName: 'Old',
          lastName: 'Name',
          email: 'old@b.com',
        },
      });
    });

    it('best-effort convergence: a mid-sequence Management failure (name PUT ok, email POST fails) re-mirrors the reverted name to Zitadel and still 503s', async () => {
      // Models the exact split-brain: a combined name+email edit where the profile name PUT commits but
      // the email POST then fails. The local row reverts to OLD, but Zitadel already holds the NEW name —
      // so the catch must issue a SECOND, best-effort updateUser pushing the reverted (OLD) name back to
      // converge the two stores, while the request still surfaces the original 503.
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'Old',
        lastName: 'Name',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'New',
          lastName: 'Name',
          email: 'new@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        })
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'Old',
          lastName: 'Name',
          email: 'old@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        });
      // First updateUser (the name PUT + email POST mirror) fails on the email POST; the SECOND call (the
      // best-effort re-mirror of the reverted name) succeeds.
      idp.updateUser
        .mockRejectedValueOnce(
          new ServiceUnavailableException('Zitadel email POST failed'),
        )
        .mockResolvedValueOnce(undefined);

      await expect(
        service.update(
          'member-1',
          { firstName: 'New', email: 'new@b.com' },
          'actor-99',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Two updateUser calls: (1) the original mirror, (2) the best-effort convergence re-mirror.
      expect(idp.updateUser).toHaveBeenCalledTimes(2);
      // The re-mirror pushes the reverted (current) name back to the SAME externalId — name only, no
      // email (the account-linking email is committed last and never diverges).
      expect(idp.updateUser).toHaveBeenLastCalledWith('zitadel-user-9', {
        firstName: 'Old',
        lastName: 'Name',
      });
      // The local row was still reverted to its prior truth despite the re-mirror.
      const updateCalls = user.update.mock.calls as Array<
        [{ where: { id: string }; data: Record<string, unknown> }]
      >;
      expect(updateCalls[1][0]).toEqual({
        where: { id: 'member-1' },
        data: { firstName: 'Old', lastName: 'Name', email: 'old@b.com' },
      });
    });

    it('best-effort re-mirror failure is swallowed: the original 503 still wins, no second error thrown', async () => {
      // Even when the convergence re-mirror ALSO fails, the caller must receive the ORIGINAL 503 — the
      // log-only re-mirror never throws over it (at worst a transient cosmetic drift remains, fixed by
      // the next edit; zero authZ impact since authorization is DB-first).
      user.findFirst.mockResolvedValue({
        id: 'member-1',
        firstName: 'Old',
        lastName: 'Name',
        email: 'old@b.com',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      user.update
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'New',
          lastName: 'Name',
          email: 'new@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        })
        .mockResolvedValueOnce({
          id: 'member-1',
          firstName: 'Old',
          lastName: 'Name',
          email: 'old@b.com',
          role: 'MEMBER',
          externalId: 'zitadel-user-9',
        });
      // BOTH updateUser calls fail (the mirror and the best-effort re-mirror).
      idp.updateUser.mockRejectedValue(
        new ServiceUnavailableException('Zitadel management call failed'),
      );

      await expect(
        service.update(
          'member-1',
          { firstName: 'New', email: 'new@b.com' },
          'actor-99',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // The re-mirror was attempted (2 calls) but its failure did not surface a different error.
      expect(idp.updateUser).toHaveBeenCalledTimes(2);
    });

    it('offboarding a linked user deactivates it in the IdP inside the transaction', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
      tx.accessGrant.updateMany.mockResolvedValue({ count: 0 });

      await service.remove('uuid-1', { userId: 'actor-99' });

      expect(idp.deactivateUser).toHaveBeenCalledWith('zitadel-user-9');
      // The soft-delete still happened (the deactivate succeeded, so the txn committed).
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });

    it('no-split-brain: a deactivateUser failure rolls back the WHOLE offboard and surfaces 503', async () => {
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        role: 'MEMBER',
        externalId: 'zitadel-user-9',
        deletedAt: null,
      });
      // The Management deactivate fails INSIDE the transaction → the txn callback throws → rollback.
      idp.deactivateUser.mockRejectedValue(
        new ServiceUnavailableException('Zitadel management call failed'),
      );

      await expect(
        service.remove('uuid-1', { userId: 'actor-99' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Because the deactivate ran FIRST in the txn and threw, nothing else was committed: no
      // soft-delete, no grant revocation, no assignment release (the rollback is the no-split-brain).
      expect(tx.user.update).not.toHaveBeenCalled();
      expect(tx.accessGrant.updateMany).not.toHaveBeenCalled();
      expect(assignments.releaseAllForUser).not.toHaveBeenCalled();
    });

    it('BYOI (generic-oidc): offboard a local-only user makes no IdP call and no 503', async () => {
      idp.supportsManagement = false;
      user.findFirst.mockResolvedValue({
        id: 'uuid-1',
        role: 'MEMBER',
        externalId: null,
        deletedAt: null,
      });
      tx.user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
      tx.accessGrant.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.remove('uuid-1', { userId: 'actor-99' }),
      ).resolves.toMatchObject({ userId: 'uuid-1' });

      // A local-only row (externalId null) has nothing to deactivate.
      expect(idp.deactivateUser).not.toHaveBeenCalled();
      expect(tx.user.update).toHaveBeenCalledTimes(1);
    });
  });

  // --- restore (re-onboard) (ADR-0041) -------------------------------------
  describe('restore', () => {
    it('clears deletedAt for a soft-deleted user and re-indexes them', async () => {
      user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: new Date() });
      user.update.mockResolvedValue({ id: 'uuid-1', deletedAt: null });

      const restored = await service.restore('uuid-1');

      // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
      expect(user.findFirst).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        includeSoftDeleted: true,
      });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        data: { deletedAt: null },
      });
      expect(restored.deletedAt).toBeNull();
      expect(search.upsert).toHaveBeenCalledWith('users', expect.anything());
    });

    it('is idempotent (no update) when the user is already live', async () => {
      user.findFirst.mockResolvedValue({ id: 'uuid-1', deletedAt: null });

      await service.restore('uuid-1');

      expect(user.update).not.toHaveBeenCalled();
    });

    it('404s when the user never existed', async () => {
      user.findFirst.mockResolvedValue(null);

      await expect(service.restore('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // Issue #149 — trigger a password reset via the IdP (lazyit never sets/sends a password).
  describe('requestPasswordReset', () => {
    function linkedActiveUser(overrides: Record<string, unknown> = {}) {
      return {
        id: 'user-1',
        firstName: 'A',
        lastName: 'B',
        email: 'a@b.com',
        role: 'MEMBER',
        isActive: true,
        externalId: 'zitadel-user-9',
        deletedAt: null,
        ...overrides,
      };
    }

    it('calls idp.requestPasswordReset with the externalId for a linked, active user', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser());

      await service.requestPasswordReset('user-1', 'actor-1');

      expect(idp.requestPasswordReset).toHaveBeenCalledWith('zitadel-user-9');
    });

    it('404s when the user is missing or soft-deleted (findOne filters)', async () => {
      user.findFirst.mockResolvedValue(null);

      await expect(
        service.requestPasswordReset('missing', 'actor-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(idp.requestPasswordReset).not.toHaveBeenCalled();
    });

    it('422s an inactive user and never calls the IdP', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser({ isActive: false }));

      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(idp.requestPasswordReset).not.toHaveBeenCalled();
    });

    it('throws PasswordResetUnsupportedError for a user with no externalId (honest 501 upstream)', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser({ externalId: null }));

      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);
      expect(idp.requestPasswordReset).not.toHaveBeenCalled();
    });

    it('BYOI: propagates the provider PasswordResetUnsupportedError (no pretend success)', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser());
      idp.requestPasswordReset.mockRejectedValue(
        new PasswordResetUnsupportedError(),
      );

      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(PasswordResetUnsupportedError);
    });

    it('surfaces a Zitadel Management failure as 503', async () => {
      user.findFirst.mockResolvedValue(linkedActiveUser());
      idp.requestPasswordReset.mockRejectedValue(
        new ServiceUnavailableException('Zitadel management call failed'),
      );

      await expect(
        service.requestPasswordReset('user-1', 'actor-1'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });
  });
});
