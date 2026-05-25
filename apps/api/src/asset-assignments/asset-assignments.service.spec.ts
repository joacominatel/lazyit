import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetAssignmentsService } from './asset-assignments.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type PrismaModelMock = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
};

// A well-formed UUID used as the X-User-Id actor in the shim tests.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

describe('AssetAssignmentsService', () => {
  let service: AssetAssignmentsService;
  let assetAssignment: PrismaModelMock;
  let user: { findFirst: jest.Mock };

  beforeEach(async () => {
    assetAssignment = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    // The actor shim (resolveActor) looks the X-User-Id up here, filtered to live users.
    user = { findFirst: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetAssignmentsService,
        { provide: PrismaService, useValue: { assetAssignment, user } },
      ],
    }).compile();

    service = moduleRef.get(AssetAssignmentsService);
  });

  // --- create -------------------------------------------------------------
  it('opens an assignment when no active one exists for the (asset, user) pair', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    assetAssignment.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto);

    expect(assetAssignment.findFirst).toHaveBeenCalledWith({
      where: { assetId: 'a1', userId: 'u1', releasedAt: null },
    });
    expect(assetAssignment.create).toHaveBeenCalledWith({ data: dto });
  });

  it('rejects a duplicate ACTIVE assignment for the same (asset, user) with 409', async () => {
    assetAssignment.findFirst.mockResolvedValue({
      id: 'existing',
      releasedAt: null,
    });

    await expect(
      service.create({ assetId: 'a1', userId: 'u1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(assetAssignment.create).not.toHaveBeenCalled();
  });

  it('allows another active assignment on the same asset for a DIFFERENT user (multi-owner)', async () => {
    // The pre-check is scoped to (a1, u2); no active pair there -> create proceeds.
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u2' };
    assetAssignment.create.mockResolvedValue({ id: 'as2', ...dto });

    await service.create(dto);

    expect(assetAssignment.create).toHaveBeenCalledWith({ data: dto });
  });

  // --- create: actor via the X-User-Id shim -------------------------------
  it('records assignedById from the X-User-Id header when it is a live user', async () => {
    user.findFirst.mockResolvedValue({ id: ACTOR_ID });
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    assetAssignment.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto, ACTOR_ID);

    expect(user.findFirst).toHaveBeenCalledWith({
      where: { id: ACTOR_ID, deletedAt: null }, // deletedAt:null is what excludes soft-deleted actors
      select: { id: true },
    });
    expect(assetAssignment.create).toHaveBeenCalledWith({
      data: { ...dto, assignedById: ACTOR_ID },
    });
  });

  it('leaves assignedById null (absent) when no X-User-Id header is sent', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    assetAssignment.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto); // no actor

    expect(user.findFirst).not.toHaveBeenCalled();
    const calls = assetAssignment.create.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0][0].data).not.toHaveProperty('assignedById');
  });

  it('rejects a malformed X-User-Id with 400 (never hits the DB)', async () => {
    await expect(
      service.create({ assetId: 'a1', userId: 'u1' }, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(user.findFirst).not.toHaveBeenCalled();
    expect(assetAssignment.create).not.toHaveBeenCalled();
  });

  it('rejects an X-User-Id that does not reference a live user with 400', async () => {
    // Covers both a nonexistent id and a soft-deleted user: the deletedAt:null filter returns null.
    user.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ assetId: 'a1', userId: 'u1' }, ACTOR_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetAssignment.create).not.toHaveBeenCalled();
  });

  // --- findAll ------------------------------------------------------------
  it('findAll defaults to active-only, newest first', async () => {
    assetAssignment.findMany.mockResolvedValue([]);

    await service.findAll({});

    expect(assetAssignment.findMany).toHaveBeenCalledWith({
      where: { releasedAt: null },
      orderBy: { assignedAt: 'desc' },
    });
  });

  it('findAll with activeOnly=false drops the releasedAt filter (includes released)', async () => {
    assetAssignment.findMany.mockResolvedValue([]);

    await service.findAll({ activeOnly: false });

    expect(assetAssignment.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { assignedAt: 'desc' },
    });
  });

  it('findAll filters by assetId and userId', async () => {
    assetAssignment.findMany.mockResolvedValue([]);

    await service.findAll({ assetId: 'a1', userId: 'u1', activeOnly: true });

    expect(assetAssignment.findMany).toHaveBeenCalledWith({
      where: { assetId: 'a1', userId: 'u1', releasedAt: null },
      orderBy: { assignedAt: 'desc' },
    });
  });

  it('findAll inlines the user only when includeUser is true', async () => {
    assetAssignment.findMany.mockResolvedValue([]);

    await service.findAll({ assetId: 'a1', includeUser: true });

    expect(assetAssignment.findMany).toHaveBeenCalledWith({
      where: { assetId: 'a1', releasedAt: null },
      orderBy: { assignedAt: 'desc' },
      include: { user: true },
    });
  });

  // --- findOne ------------------------------------------------------------
  it('returns an assignment by id when it exists', async () => {
    const found = { id: 'as1', releasedAt: null };
    assetAssignment.findUnique.mockResolvedValue(found);

    await expect(service.findOne('as1')).resolves.toEqual(found);
    expect(assetAssignment.findUnique).toHaveBeenCalledWith({
      where: { id: 'as1' },
    });
  });

  it('throws NotFound when the assignment does not exist', async () => {
    assetAssignment.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- release (actor via the X-User-Id shim) -----------------------------
  it('releases an active assignment, recording releasedById from the X-User-Id header + notes', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: null,
    });
    user.findFirst.mockResolvedValue({ id: ACTOR_ID });
    assetAssignment.update.mockResolvedValue({
      id: 'as1',
      releasedAt: new Date(),
    });

    await service.release('as1', { notes: 'returned' }, ACTOR_ID);

    expect(assetAssignment.update).toHaveBeenCalledTimes(1);
    const calls = assetAssignment.update.mock.calls as Array<
      [
        {
          where: { id: string };
          data: { releasedAt: Date; releasedById?: string; notes?: string };
        },
      ]
    >;
    expect(calls[0][0].where).toEqual({ id: 'as1' });
    expect(calls[0][0].data.releasedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.releasedById).toBe(ACTOR_ID);
    expect(calls[0][0].data.notes).toBe('returned');
  });

  it('leaves releasedById null (absent) when no X-User-Id header is sent', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: null,
    });
    assetAssignment.update.mockResolvedValue({ id: 'as1' });

    await service.release('as1', {}); // no actor

    expect(user.findFirst).not.toHaveBeenCalled();
    const calls = assetAssignment.update.mock.calls as Array<
      [{ data: Record<string, unknown> }]
    >;
    expect(calls[0][0].data).not.toHaveProperty('releasedById');
  });

  it('rejects a malformed X-User-Id on release with 400 (no update)', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: null,
    });

    await expect(
      service.release('as1', {}, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetAssignment.update).not.toHaveBeenCalled();
  });

  it('rejects releasing an already-released assignment with 409', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: new Date(),
    });

    await expect(service.release('as1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(assetAssignment.update).not.toHaveBeenCalled();
  });

  it('does not release a missing assignment', async () => {
    assetAssignment.findUnique.mockResolvedValue(null);

    await expect(service.release('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(assetAssignment.update).not.toHaveBeenCalled();
  });

  // --- updateNotes --------------------------------------------------------
  it('updates only the notes after confirming the assignment exists', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: null,
    });
    assetAssignment.update.mockResolvedValue({ id: 'as1', notes: 'new note' });

    await service.updateNotes('as1', { notes: 'new note' });

    expect(assetAssignment.update).toHaveBeenCalledWith({
      where: { id: 'as1' },
      data: { notes: 'new note' },
    });
  });

  it('clears the notes when passed null', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      releasedAt: null,
    });
    assetAssignment.update.mockResolvedValue({ id: 'as1', notes: null });

    await service.updateNotes('as1', { notes: null });

    expect(assetAssignment.update).toHaveBeenCalledWith({
      where: { id: 'as1' },
      data: { notes: null },
    });
  });

  it('does not update notes of a missing assignment', async () => {
    assetAssignment.findUnique.mockResolvedValue(null);

    await expect(
      service.updateNotes('missing', { notes: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(assetAssignment.update).not.toHaveBeenCalled();
  });

  // NOTE: two rules are enforced at the DB layer and verified against Postgres rather than here
  // (mocked unit tests have no DB — ADR-0012): (1) a duplicate *active* (asset, user) pair, via
  // the partial unique index -> P2002 -> 409; (2) hard-deleting an asset/user that has
  // assignments, via the FK `onDelete: Restrict` -> P2003. The create() pre-check above already
  // covers the common (non-racy) duplicate case with a friendly 409.
});
