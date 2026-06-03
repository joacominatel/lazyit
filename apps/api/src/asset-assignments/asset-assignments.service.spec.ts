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

// A well-formed UUID used as the human actor in tests, and a service-account id (ADR-0048).
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
const SA_ID = 'sa_abcdefghijklmnopqrstuvwx';
// The unified principals passed to the service (the guard builds these at runtime). Only the actor id
// matters to attribution; cast through `never` so the test needn't shape the full User/ServiceAccount.
const HUMAN_PRINCIPAL = { kind: 'human', user: { id: ACTOR_ID } } as never;
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(),
} as never;

describe('AssetAssignmentsService', () => {
  let service: AssetAssignmentsService;
  let assetAssignment: PrismaModelMock;
  let asset: { findFirst: jest.Mock };
  let user: { findFirst: jest.Mock };
  let tx: TxAssignmentMock;
  let prisma: {
    assetAssignment: PrismaModelMock;
    asset: { findFirst: jest.Mock };
    user: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let actor: ActorService;
  let history: { record: jest.Mock; list: jest.Mock };

  beforeEach(async () => {
    assetAssignment = {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    };
    // create() now asserts the asset and user are live (non-soft-deleted) rows before opening the
    // transaction (mirrors AccessGrantsService). Default both to "found" so the existing create
    // tests still reach the create path; the guard tests override to null.
    asset = { findFirst: jest.fn().mockResolvedValue({ id: 'a1' }) };
    user = { findFirst: jest.fn().mockResolvedValue({ id: 'u1' }) };
    tx = { create: jest.fn(), update: jest.fn() };
    prisma = {
      assetAssignment,
      asset,
      user,
      $transaction: jest.fn(
        (cb: (client: { assetAssignment: TxAssignmentMock }) => unknown) =>
          cb({ assetAssignment: tx }),
      ),
    };
    // ActorService is a pure, dependency-free resolver (the guard already validated the principal), so
    // the real instance is used — it produces the genuine ActorAttribution from the principal we pass.
    actor = new ActorService();
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
        actor: {},
      },
    );
  });

  // --- create: actor via the unified principal (ADR-0048) -----------------
  it('records assignedById from a HUMAN principal and stamps it on the ASSIGNED event', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto, HUMAN_PRINCIPAL);

    // A human → assignedById, never assignedBySaId (behavior-preserving).
    expect(tx.create).toHaveBeenCalledWith({
      data: { ...dto, assignedById: ACTOR_ID },
    });
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      {
        assetId: 'a1',
        eventType: 'ASSIGNED',
        payload: { userId: 'u1' },
        actor: { userId: ACTOR_ID },
      },
    );
  });

  it('records assignedBySaId from a SERVICE-ACCOUNT principal (userId column stays null) — ADR-0048', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto, SA_PRINCIPAL);

    // A service account → assignedBySaId; the human column is absent → the per-slot CHECK holds.
    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).toEqual({ ...dto, assignedBySaId: SA_ID });
    expect(calls[0][0].data).not.toHaveProperty('assignedById');
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      {
        assetId: 'a1',
        eventType: 'ASSIGNED',
        payload: { userId: 'u1' },
        actor: { serviceAccountId: SA_ID },
      },
    );
  });

  it('leaves both actor columns absent when there is no principal (anonymous/system)', async () => {
    assetAssignment.findFirst.mockResolvedValue(null);
    const dto = { assetId: 'a1', userId: 'u1' };
    tx.create.mockResolvedValue({ id: 'as1', ...dto });

    await service.create(dto);

    const calls = tx.create.mock.calls as CreateCall[];
    expect(calls[0][0].data).not.toHaveProperty('assignedById');
    expect(calls[0][0].data).not.toHaveProperty('assignedBySaId');
  });

  // --- create: live-row guards (mirror AccessGrantsService.assertUsable) ---
  it('rejects assigning a soft-deleted (or missing) asset with 400, before the duplicate check', async () => {
    // The soft-delete read filter hides deleted assets → findFirst returns null.
    asset.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ assetId: 'gone', userId: 'u1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(assetAssignment.findFirst).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.create).not.toHaveBeenCalled();
  });

  it('rejects assigning to a soft-deleted (or missing) user with 400, before the duplicate check', async () => {
    user.findFirst.mockResolvedValue(null);

    await expect(
      service.create({ assetId: 'a1', userId: 'gone' }),
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

  // --- release (actor via the unified principal, ADR-0048) ----------------
  it('releases an active assignment (in a transaction), recording releasedById + notes for a HUMAN', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', { notes: 'returned' }, HUMAN_PRINCIPAL);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.update).toHaveBeenCalledTimes(1);
    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'as1' });
    expect(calls[0][0].data.releasedAt).toBeInstanceOf(Date);
    expect(calls[0][0].data.releasedById).toBe(ACTOR_ID);
    expect(calls[0][0].data).not.toHaveProperty('releasedBySaId');
    expect(calls[0][0].data.notes).toBe('returned');
  });

  it('records releasedBySaId for a SERVICE-ACCOUNT release (releasedById stays null) — ADR-0048', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', {}, SA_PRINCIPAL);

    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data.releasedBySaId).toBe(SA_ID);
    expect(calls[0][0].data).not.toHaveProperty('releasedById');
  });

  it("records a RELEASED history event (with the released owner's userId payload) attributed to the HUMAN", async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      userId: 'u1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1', releasedAt: new Date() });

    await service.release('as1', {}, HUMAN_PRINCIPAL);

    expect(history.record).toHaveBeenCalledTimes(1);
    expect(history.record).toHaveBeenCalledWith(
      { assetAssignment: tx },
      {
        assetId: 'a1',
        eventType: 'RELEASED',
        payload: { userId: 'u1' },
        actor: { userId: ACTOR_ID },
      },
    );
  });

  it('leaves both release actor columns absent when there is no principal (anonymous/system)', async () => {
    assetAssignment.findUnique.mockResolvedValue({
      id: 'as1',
      assetId: 'a1',
      releasedAt: null,
    });
    tx.update.mockResolvedValue({ id: 'as1' });

    await service.release('as1', {});

    const calls = tx.update.mock.calls as UpdateCall[];
    expect(calls[0][0].data).not.toHaveProperty('releasedById');
    expect(calls[0][0].data).not.toHaveProperty('releasedBySaId');
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
    // Early-exit before any write: the conflict is detected before the transaction opens.
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

  // --- releaseAllForUser (bulk release on offboarding) --------------------
  // The helper takes the caller's transaction client directly (it is invoked from inside the
  // users.service offboarding $transaction), so the tests pass a hand-built tx client.
  describe('releaseAllForUser', () => {
    type BulkTx = {
      assetAssignment: { findMany: jest.Mock; update: jest.Mock };
    };
    let bulkTx: BulkTx;

    beforeEach(() => {
      bulkTx = {
        assetAssignment: { findMany: jest.fn(), update: jest.fn() },
      };
    });

    it('releases every active assignment and emits one RELEASED event per asset', async () => {
      bulkTx.assetAssignment.findMany.mockResolvedValue([
        { id: 'as1', assetId: 'a1' },
        { id: 'as2', assetId: 'a2' },
      ]);

      const released = await service.releaseAllForUser(bulkTx as never, 'u1', {
        userId: ACTOR_ID,
      });

      // Only the user's ACTIVE assignments are targeted.
      expect(bulkTx.assetAssignment.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', releasedAt: null },
        select: { id: true, assetId: true },
      });
      // Each is stamped releasedAt + releasedById = the human actor (never releasedBySaId).
      expect(bulkTx.assetAssignment.update).toHaveBeenCalledTimes(2);
      const calls = bulkTx.assetAssignment.update.mock.calls as Array<
        [
          {
            where: { id: string };
            data: {
              releasedAt: Date;
              releasedById?: string;
              releasedBySaId?: string;
            };
          },
        ]
      >;
      expect(calls[0][0].where).toEqual({ id: 'as1' });
      expect(calls[0][0].data.releasedAt).toBeInstanceOf(Date);
      expect(calls[0][0].data.releasedById).toBe(ACTOR_ID);
      expect(calls[0][0].data).not.toHaveProperty('releasedBySaId');
      expect(calls[1][0].where).toEqual({ id: 'as2' });
      // One RELEASED history event per asset, on the SAME tx client, each carrying the released
      // owner's userId (the offboarded user 'u1') so the per-asset timeline is attributable.
      expect(history.record).toHaveBeenCalledTimes(2);
      expect(history.record).toHaveBeenNthCalledWith(1, bulkTx, {
        assetId: 'a1',
        eventType: 'RELEASED',
        payload: { userId: 'u1' },
        actor: { userId: ACTOR_ID },
      });
      expect(history.record).toHaveBeenNthCalledWith(2, bulkTx, {
        assetId: 'a2',
        eventType: 'RELEASED',
        payload: { userId: 'u1' },
        actor: { userId: ACTOR_ID },
      });
      expect(released).toEqual([
        { id: 'as1', assetId: 'a1' },
        { id: 'as2', assetId: 'a2' },
      ]);
    });

    it('stamps releasedBySaId on each release for a SERVICE-ACCOUNT offboarding actor — ADR-0048', async () => {
      bulkTx.assetAssignment.findMany.mockResolvedValue([
        { id: 'as1', assetId: 'a1' },
      ]);

      await service.releaseAllForUser(bulkTx as never, 'u1', {
        serviceAccountId: SA_ID,
      });

      const calls = bulkTx.assetAssignment.update.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(calls[0][0].data.releasedBySaId).toBe(SA_ID);
      expect(calls[0][0].data).not.toHaveProperty('releasedById');
      expect(history.record).toHaveBeenCalledWith(bulkTx, {
        assetId: 'a1',
        eventType: 'RELEASED',
        payload: { userId: 'u1' },
        actor: { serviceAccountId: SA_ID },
      });
    });

    it('omits both release actor columns when no actor is given', async () => {
      bulkTx.assetAssignment.findMany.mockResolvedValue([
        { id: 'as1', assetId: 'a1' },
      ]);

      await service.releaseAllForUser(bulkTx as never, 'u1');

      const calls = bulkTx.assetAssignment.update.mock.calls as Array<
        [{ data: Record<string, unknown> }]
      >;
      expect(calls[0][0].data).not.toHaveProperty('releasedById');
      expect(calls[0][0].data).not.toHaveProperty('releasedBySaId');
    });

    it('is a no-op (returns []) when the user owns no active assignment', async () => {
      bulkTx.assetAssignment.findMany.mockResolvedValue([]);

      const released = await service.releaseAllForUser(bulkTx as never, 'u1');

      expect(released).toEqual([]);
      expect(bulkTx.assetAssignment.update).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
    });
  });

  // NOTE: two rules are enforced at the DB layer and verified against Postgres rather than here
  // (mocked unit tests have no DB — ADR-0012): (1) a duplicate *active* (asset, user) pair, via
  // the partial unique index -> P2002 -> 409; (2) hard-deleting an asset/user that has
  // assignments, via the FK `onDelete: Restrict` -> P2003. The create() pre-check above already
  // covers the common (non-racy) duplicate case with a friendly 409.
});
