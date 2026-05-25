import { Test } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
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

describe('AssetAssignmentsService', () => {
  let service: AssetAssignmentsService;
  let assetAssignment: PrismaModelMock;

  beforeEach(async () => {
    assetAssignment = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetAssignmentsService,
        { provide: PrismaService, useValue: { assetAssignment } },
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

  // --- release ------------------------------------------------------------
  it('releases an active assignment by setting releasedAt (+ releasedById, notes)', async () => {
    assetAssignment.findUnique.mockResolvedValue({ id: 'as1', releasedAt: null });
    assetAssignment.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', { releasedById: 'u9', notes: 'returned' });

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
    expect(calls[0][0].data.releasedById).toBe('u9');
    expect(calls[0][0].data.notes).toBe('returned');
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
    assetAssignment.findUnique.mockResolvedValue({ id: 'as1', releasedAt: null });
    assetAssignment.update.mockResolvedValue({ id: 'as1', notes: 'new note' });

    await service.updateNotes('as1', { notes: 'new note' });

    expect(assetAssignment.update).toHaveBeenCalledWith({
      where: { id: 'as1' },
      data: { notes: 'new note' },
    });
  });

  it('clears the notes when passed null', async () => {
    assetAssignment.findUnique.mockResolvedValue({ id: 'as1', releasedAt: null });
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
