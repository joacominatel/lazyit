import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetAssignmentsService } from './asset-assignments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';

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

// The transaction client the writes go through; $transaction runs the callback with it.
type TxAssignmentMock = {
  create: jest.Mock;
  update: jest.Mock;
};

// Shapes the create/update calls are cast to, so assertions stay type-safe (no-unsafe-* lint).
type AssignmentData = Record<string, unknown>;
type CreateCall = [{ data: AssignmentData }];
type UpdateCall = [{ where: { id: string }; data: AssignmentData }];

// A well-formed UUID used as the X-User-Id actor in the shim tests.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

describe('AssetAssignmentsService', () => {
  let service: AssetAssignmentsService;
  let assetAssignment: PrismaModelMock;
  let tx: TxAssignmentMock;
  let prisma: {
    assetAssignment: PrismaModelMock;
    $transaction: jest.Mock;
  };
  let actor: { resolve: jest.Mock };
  let history: { record: jest.Mock; list: jest.Mock };

  beforeEach(async () => {
    assetAssignment = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    tx = { create: jest.fn(), update: jest.fn() };
    prisma = {
      assetAssignment,
      $transaction: jest.fn(
        (cb: (client: { assetAssignment: TxAssignmentMock }) => unknown) =>
          cb({ assetAssignment: tx }),
      ),
    };
    // ActorService is mocked; shim-validation detail lives in actor.service.spec.ts. Here we steer
    // resolve() and assert the service delegates to it. Default: no actor (undefined).
    actor = { resolve: jest.fn().mockResolvedValue(undefined) };
    history = { record: jest.fn(), list: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AssetAssignmentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
        { provide: AssetHistoryService, useValue: history },
      ],
    }).compile();

    service = moduleRef.get(AssetAssignmentsService);
  });

  // --- create -------------------------------------------------------------
  it('opens an assignment (in a transaction) when no active one exists for the (asset, user) pair', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto);

    expect(assetAssignment.findFirst).toHaveBeenCalledWith({
      where: { assetId: 'a1', userId: 'u1', releasedAt: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.create).toHaveBeenCalledWith({ data: dto });
  });

  it('rejects a duplicate ACTIVE assignment for the same (asset, user) with 409', async () => {
    assetAssignment.findFirst.mockResolvedValue({
      id: 'existing',
      releasedAt: null,
    });

    await expect(
      service.create({ assetId: 'a1', userId: 'u1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
  });

  it('allows another active assignment on the same asset for a DIFFERENT user (multi-owner)', async () => {
    // The pre-check is scoped to (a1, u2); no active pair there -> create proceeds.
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u2' };
    tx.create.mockResolvedValue({ id: 'as2', ...dto });

    await service.create(dto);

    expect(tx.create).toHaveBeenCalledWith({ data: dto });
  });

  it('records an ASSIGNED history event for the asset (with the userId payload) in the transaction', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      {
        assetId: 'a1',
        eventType: 'ASSIGNED',
        payload: { userId: 'u1' },
        performedById: undefined,
      },
    );
  });

  // --- create: actor via the X-User-Id shim -------------------------------
  it('records assignedById from the resolved actor and stamps it on the ASSIGNED event', async () => {
    actor.resolve.mockResolvedValue(ACTOR_ID);
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto, ACTOR_ID);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_ID);
    expect(tx.create).toHaveBeenCalledWith({
      data: { ...dto, assignedById: ACTOR_ID },
    });
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      {
        assetId: 'a1',
        eventType: 'ASSIGNED',
        payload: { userId: 'u1' },
        performedById: ACTOR_ID,
      },
    );
  });

  it('leaves assignedById absent when the actor resolves to undefined (no header)', async () => {
    actor.resolve.mockResolvedValue(undefined);
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto);

    expect(actor.resolve).toHaveBeenCalledWith(undefined);
    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).not.toHaveProperty('assignedById');
  });

  it('propagates a BadRequest from the actor shim and never opens the transaction', async () => {
    actor.resolve.mockRejectedValue(new BadRequestException());

    await expect(
      service.create({ assetId: 'a1', userId: 'u1' }, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
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
  it('releases an active assignment (in a transaction), recording releasedById + notes', async () => {
    actor.resolve.mockResolvedValue(ACTOR_ID);
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', { notes: 'returned' }, ACTOR_ID);

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_ID);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'as1' });
    expect(calls[0][0].data.releasedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.releasedById).toBe(ACTOR_ID);
    expect(calls[0][0].data.notes).toBe('returned');
  });

  it('records a RELEASED history event for the assignment’s asset', async () => {
    actor.resolve.mockResolvedValue(ACTOR_ID);
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', {}, ACTOR_ID);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      { assetId: 'a1', eventType: 'RELEASED', performedById: ACTOR_ID },
    );
  });

  it('leaves releasedById absent when the actor resolves to undefined (no header)', async () => {
    actor.resolve.mockResolvedValue(undefined);
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1' });

    await service.release('as1', {});

    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data).not.toHaveProperty('releasedById');
  });

  it('propagates a BadRequest from the actor shim on release and never opens the transaction', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    actor.resolve.mockRejectedValue(new BadRequestException());

    await expect(
      service.release('as1', {}, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('rejects releasing an already-released assignment with 409 (before touching the actor)', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: new Date(),
    });

    await expect(service.release('as1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(actor.resolve).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it('does not release a missing assignment', async () => {
    assetAssignment.findUnique.mockResolvedValue(null);

    await expect(service.release('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
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
