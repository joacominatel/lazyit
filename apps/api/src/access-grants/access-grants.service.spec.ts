import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AccessGrantsService } from './access-grants.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// `Prisma` only for types (erased at runtime), so an empty object is enough.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type GrantMock = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

// Shapes the create/update calls are cast to, so assertions stay type-safe (no-unsafe-* lint).
type GrantData = {
  userId?: string;
  applicationId?: string;
  accessLevel?: string;
  expiresAt?: Date | null;
  grantedAt?: Date;
  notes?: string | null;
  grantedById?: string;
  revokedAt?: Date;
  revokedById?: string;
};
type CreateCall = [{ data: GrantData }];
type UpdateCall = [{ where: { id: string }; data: GrantData }];
type FindManyCall = [{ where: Record<string, unknown>; orderBy: unknown }];

const VALID_ACTOR = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const APP_ID = 'app_cuid_1';
// Minimal User shape for tests — the full Prisma User type, but only id matters here.
type MinimalUser = { id: string };
const ACTOR_USER: MinimalUser = { id: VALID_ACTOR };

describe('AccessGrantsService', () => {
  let service: AccessGrantsService;
  let accessGrant: GrantMock;
  let user: { findFirst: jest.Mock };
  let application: { findFirst: jest.Mock };
  // ActorService is mocked; the X-User-Id validation detail lives in actor.service.spec.ts. Here we
  // steer resolve() and assert the service delegates to it. Default: no actor (undefined).
  let actor: { resolve: jest.Mock };

  beforeEach(async () => {
    accessGrant = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    user = { findFirst: jest.fn() };
    application = { findFirst: jest.fn() };
    // resolve() is now synchronous — mockReturnValue, not mockResolvedValue.
    actor = { resolve: jest.fn().mockReturnValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccessGrantsService,
        {
          provide: PrismaService,
          useValue: { accessGrant, user, application },
        },
        { provide: ActorService, useValue: actor },
      ],
    }).compile();

    service = moduleRef.get(AccessGrantsService);
  });

  /** user.findFirst echoes the queried id back as a live user (grantee/application lookups pass). */
  const allUsersLive = () =>
    user.findFirst.mockImplementation((args: { where: { id: string } }) =>
      Promise.resolve({ id: args.where.id }),
    );

  // --- create -------------------------------------------------------------
  it('opens a grant for a live user + application; no actor header => grantedById unset', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create({ userId: USER_ID, applicationId: APP_ID });

    const calls = accessGrant.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.userId).toBe(USER_ID);
    expect(calls[0][0].data.applicationId).toBe(APP_ID);
    expect(calls[0][0].data.grantedById).toBeUndefined();
  });

  it('records grantedById from the authenticated actor when present', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });
    actor.resolve.mockReturnValue(VALID_ACTOR);

    await service.create(
      { userId: USER_ID, applicationId: APP_ID },
      ACTOR_USER as never,
    );

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_USER);
    const calls = accessGrant.create.mock.calls as CreateCall[];
    expect(calls[0][0].data.grantedById).toBe(VALID_ACTOR);
  });

  it('persists accessLevel and converts expiresAt / grantedAt to Date', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g1' });

    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'admin',
      expiresAt: '2026-12-31T00:00:00.000Z',
      grantedAt: '2026-01-01T00:00:00.000Z',
      notes: 'temp consultant',
    });

    const data = (accessGrant.create.mock.calls as CreateCall[])[0][0].data;
    expect(data.accessLevel).toBe('admin');
    expect(data.expiresAt).toBeInstanceOf(Date);
    expect(data.grantedAt).toBeInstanceOf(Date);
    expect(data.notes).toBe('temp consultant');
  });

  it('allows multi-grant: a 2nd grant for the same (user, app) at a different level is not blocked', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue({ id: APP_ID });
    accessGrant.create.mockResolvedValue({ id: 'g' });

    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'admin',
    });
    await service.create({
      userId: USER_ID,
      applicationId: APP_ID,
      accessLevel: 'viewer',
    });

    // No uniqueness pre-check: both creates go through (contrast AssetAssignment).
    expect(accessGrant.create).toHaveBeenCalledTimes(2);
  });

  it('rejects (400) when the grantee user is not live', async () => {
    user.findFirst.mockResolvedValue(null);
    application.findFirst.mockResolvedValue({ id: APP_ID });

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  it('rejects (400) when the application is not live', async () => {
    allUsersLive();
    application.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
  });

  it('propagates a thrown error from the actor resolver and short-circuits (no create, no app lookup)', async () => {
    // If the actor resolver throws (e.g. from guard internals), create() must surface the error
    // before touching the grantee/application checks.
    actor.resolve.mockImplementation(() => {
      throw new BadRequestException('actor error');
    });

    await expect(
      service.create({ userId: USER_ID, applicationId: APP_ID }, ACTOR_USER as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(accessGrant.create).not.toHaveBeenCalled();
    expect(application.findFirst).not.toHaveBeenCalled();
  });

  // --- findAll ------------------------------------------------------------
  it('findAll defaults to active-only + include-expired, newest first', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({});

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { revokedAt: null },
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll with activeOnly=false drops the revokedAt filter', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ activeOnly: false });

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll filters by userId and applicationId', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ userId: USER_ID, applicationId: APP_ID });

    expect(accessGrant.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, applicationId: APP_ID, revokedAt: null },
      orderBy: { grantedAt: 'desc' },
    });
  });

  it('findAll with includeExpired=false adds an (expiresAt null OR in the future) filter', async () => {
    accessGrant.findMany.mockResolvedValue([]);

    await service.findAll({ includeExpired: false });

    const where = (accessGrant.findMany.mock.calls as FindManyCall[])[0][0]
      .where as {
      revokedAt: null;
      OR: Array<{ expiresAt: null | { gt: Date } }>;
    };
    expect(where.revokedAt).toBeNull();
    expect(where.OR).toHaveLength(2);
    expect(where.OR[0]).toEqual({ expiresAt: null });
    const future = where.OR[1].expiresAt as { gt: Date };
    expect(future.gt).toBeInstanceOf(Date);
  });

  // --- findOne ------------------------------------------------------------
  it('returns a grant by id when it exists', async () => {
    const found = { id: 'g1', revokedAt: null };
    accessGrant.findUnique.mockResolvedValue(found);

    await expect(service.findOne('g1')).resolves.toEqual(found);
    expect(accessGrant.findUnique).toHaveBeenCalledWith({
      where: { id: 'g1' },
    });
  });

  it('throws NotFound when the grant does not exist', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- revoke -------------------------------------------------------------
  it('revokes an active grant: sets revokedAt + revokedById (from actor) + notes', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    actor.resolve.mockReturnValue(VALID_ACTOR);
    accessGrant.update.mockResolvedValue({ id: 'g1', revokedAt: new Date() });

    await service.revoke('g1', { notes: 'left the company' }, ACTOR_USER as never);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_USER);
    const calls = accessGrant.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'g1' });
    expect(calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.revokedById).toBe(VALID_ACTOR);
    expect(calls[0][0].data.notes).toBe('left the company');
  });

  it('revokes without an actor header (revokedById stays unset)', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1' });

    await service.revoke('g1', {});

    const calls = accessGrant.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data.revokedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.revokedById).toBeUndefined();
  });

  it('rejects revoking an already-revoked grant with 409', async () => {
    accessGrant.findUnique.mockResolvedValue({
      id: 'g1',
      revokedAt: new Date(),
    });

    await expect(service.revoke('g1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(accessGrant.update).not.toHaveBeenCalled();
  });

  it('does not revoke a missing grant', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(service.revoke('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(accessGrant.update).not.toHaveBeenCalled();
  });

  // --- updateNotes --------------------------------------------------------
  it('updates only the notes after confirming the grant exists', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1', notes: 'note' });

    await service.updateNotes('g1', { notes: 'note' });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { notes: 'note' },
    });
  });

  it('clears the notes when passed null', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1', notes: null });

    await service.updateNotes('g1', { notes: null });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { notes: null },
    });
  });

  // --- updateExpiry -------------------------------------------------------
  it('updates the expiry, converting the ISO string to a Date', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1' });

    await service.updateExpiry('g1', { expiresAt: '2027-01-01T00:00:00.000Z' });

    const calls = accessGrant.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data.expiresAt).toBeInstanceOf(Date);
  });

  it('clears the expiry (permanent grant) when passed null', async () => {
    accessGrant.findUnique.mockResolvedValue({ id: 'g1', revokedAt: null });
    accessGrant.update.mockResolvedValue({ id: 'g1', expiresAt: null });

    await service.updateExpiry('g1', { expiresAt: null });

    expect(accessGrant.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { expiresAt: null },
    });
  });

  it('does not update the expiry of a missing grant', async () => {
    accessGrant.findUnique.mockResolvedValue(null);

    await expect(
      service.updateExpiry('missing', { expiresAt: null }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(accessGrant.update).not.toHaveBeenCalled();
  });

  // NOTE: two rules are enforced at the DB layer and verified against Postgres rather than here
  // (mocked unit tests have no DB — ADR-0012): (1) FK `onDelete: Restrict` blocks hard-deleting a
  // user/application that has grants (P2003 -> 400); (2) there is intentionally NO uniqueness
  // constraint, so multi-grant is a DB-level non-rule. The create() live-checks above cover the
  // soft-deleted-reference case (400) that the FK cannot.
});
