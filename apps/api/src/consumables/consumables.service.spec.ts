import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConsumablesService } from './consumables.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));

type ConsumableModelMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
  // Field reference used by the lowStock filter (prisma.consumable.fields.minStock).
  fields: { minStock: unknown };
};

type MovementModelMock = {
  findMany: jest.Mock;
  create: jest.Mock;
};

// The transaction client the movement goes through; $transaction runs the callback with it.
type TxMock = {
  consumable: {
    findFirst: jest.Mock;
    update: jest.Mock;
    updateMany: jest.Mock;
  };
  consumableMovement: { create: jest.Mock };
};

type MovementData = Record<string, unknown>;
type CreateMovementCall = [{ data: MovementData }];
type StockUpdateCall = [
  { where: { id: string }; data: { currentStock: number } },
];

// A sentinel object standing in for the Prisma FieldRef; we only assert identity.
const MIN_STOCK_FIELD = { __fieldRef: 'minStock' };

// A well-formed UUID used as the actor in tests.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
// Minimal User shape for tests — the full Prisma User type, but only id matters here.
type MinimalUser = { id: string };
const ACTOR_USER: MinimalUser = { id: ACTOR_ID };

describe('ConsumablesService', () => {
  let service: ConsumablesService;
  let consumable: ConsumableModelMock;
  let consumableMovement: MovementModelMock;
  let tx: TxMock;
  let prisma: {
    consumable: ConsumableModelMock;
    consumableMovement: MovementModelMock;
    $transaction: jest.Mock;
  };
  let actor: { resolve: jest.Mock };

  beforeEach(async () => {
    consumable = {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      fields: { minStock: MIN_STOCK_FIELD },
    };
    consumableMovement = { findMany: jest.fn(), create: jest.fn() };
    tx = {
      consumable: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      consumableMovement: { create: jest.fn() },
    };
    prisma = {
      consumable,
      consumableMovement,
      // Handles BOTH forms: callback (createMovement) and array (findPage's [findMany, count]).
      $transaction: jest.fn(
        (arg: ((client: TxMock) => unknown) | Promise<unknown>[]) =>
          Array.isArray(arg) ? Promise.all(arg) : arg(tx),
      ),
    };
    // ActorService is mocked; guard validation detail lives in jwt-auth.guard.spec.ts. Default: no actor.
    // resolve() is now synchronous — mockReturnValue, not mockResolvedValue.
    actor = { resolve: jest.fn().mockReturnValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsumablesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
      ],
    }).compile();

    service = moduleRef.get(ConsumablesService);
  });

  // --- findPage -----------------------------------------------------------
  it('findPage lists by name asc with no filter by default, returning the Page envelope', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'k1' }]);
    consumable.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(consumable.findMany).toHaveBeenCalledWith({
      // Consumable is NOT in the ADR-0032 SOFT_DELETABLE_MODELS set, so the `active` slice scopes to
      // live rows EXPLICITLY here (the read filter does not auto-scope it) — ADR-0041 addendum.
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      take: 50,
      skip: 0,
    });
    expect(page).toEqual({
      items: [{ id: 'k1' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('findPage lowStock compares currentStock against the minStock field reference', async () => {
    consumable.findMany.mockResolvedValue([]);
    consumable.count.mockResolvedValue(0);

    await service.findPage(
      { lowStock: true },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      consumable.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({
      minStock: { not: null },
      currentStock: { lte: MIN_STOCK_FIELD },
      deletedAt: null,
    });
  });

  it('findPage applies a case-insensitive q over name/sku/description', async () => {
    consumable.findMany.mockResolvedValue([]);
    consumable.count.mockResolvedValue(0);

    await service.findPage(
      { q: 'hdmi' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      consumable.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({
      OR: [
        { name: { contains: 'hdmi', mode: 'insensitive' } },
        { sku: { contains: 'hdmi', mode: 'insensitive' } },
        { description: { contains: 'hdmi', mode: 'insensitive' } },
      ],
      deletedAt: null,
    });
  });

  it('findPage honors an allowlisted sort and rejects an unknown one (400)', async () => {
    consumable.findMany.mockResolvedValue([]);
    consumable.count.mockResolvedValue(0);

    await service.findPage(
      {},
      {
        limit: 50,
        offset: 0,
        sort: 'currentStock',
        dir: 'desc',
        deleted: 'active',
      },
    );
    const call = (
      consumable.findMany.mock.calls as Array<
        [{ orderBy: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.orderBy).toEqual({ currentStock: 'desc' });

    await expect(
      service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'evil', dir: 'asc', deleted: 'active' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('findPage deleted=only returns soft-deleted rows (explicit deletedAt + escape hatch) (ADR-0041)', async () => {
    consumable.findMany.mockResolvedValue([{ id: 'gone' }]);
    consumable.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'only' },
    );

    expect(consumable.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      orderBy: { name: 'asc' },
      take: 50,
      skip: 0,
      includeSoftDeleted: true,
    });
    expect(consumable.count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
    expect(page.items).toEqual([{ id: 'gone' }]);
  });

  // --- findOne / create / update / remove ---------------------------------
  it('returns a consumable by id when it exists', async () => {
    const found = { id: 'k1', name: 'HDMI cable', currentStock: 5 };
    consumable.findFirst.mockResolvedValue(found);

    await expect(service.findOne('k1')).resolves.toEqual(found);
    expect(consumable.findFirst).toHaveBeenCalledWith({ where: { id: 'k1' } });
  });

  it('throws NotFound when the consumable does not exist', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('creates a consumable (never sets currentStock)', async () => {
    const dto = { name: 'HDMI cable', unit: 'units' };
    const created = { id: 'k1', ...dto, currentStock: 0 };
    consumable.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(consumable.create).toHaveBeenCalledWith({ data: dto });
  });

  it('applies a partial update after confirming the consumable exists', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumable.update.mockResolvedValue({ id: 'k1', minStock: 3 });

    await service.update('k1', { minStock: 3 });

    expect(consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { minStock: 3 },
    });
  });

  it('does not update a missing consumable', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { minStock: 3 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(consumable.update).not.toHaveBeenCalled();
  });

  it('soft-deletes a consumable', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumable.update.mockResolvedValue({ id: 'k1', deletedAt: new Date() });

    await service.remove('k1');

    const calls = consumable.update.mock.calls as StockUpdateCall[];
    expect(calls[0][0].where).toEqual({ id: 'k1' });
    expect(
      (calls[0][0].data as unknown as { deletedAt: Date }).deletedAt,
    ).toBeInstanceOf(Date);
  });

  it('does not soft-delete a missing consumable', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consumable.update).not.toHaveBeenCalled();
  });

  // --- createMovement: stock math -----------------------------------------
  it('IN atomically increments currentStock and persists the movement in a transaction', async () => {
    tx.consumable.findFirst.mockResolvedValue({ currentStock: 5 });
    tx.consumable.update.mockResolvedValue({ id: 'k1' });
    tx.consumableMovement.create.mockResolvedValue({ id: 1 });

    await service.createMovement('k1', { type: 'IN', quantity: 3 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Atomic increment, not a JS read-modify-write of an absolute value.
    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: { increment: 3 } },
    });
    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).toMatchObject({
      consumableId: 'k1',
      type: 'IN',
      quantity: 3,
    });
  });

  it('OUT decrements via a guarded updateMany (gte + live row) and records the movement', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 1 });
    tx.consumableMovement.create.mockResolvedValue({ id: 2 });

    await service.createMovement('k1', { type: 'OUT', quantity: 2 });

    expect(tx.consumable.updateMany).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null, currentStock: { gte: 2 } },
      data: { currentStock: { decrement: 2 } },
    });
    // No JS read-modify-write `update` on the OUT path.
    expect(tx.consumable.update).not.toHaveBeenCalled();
    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).toMatchObject({
      consumableId: 'k1',
      type: 'OUT',
      quantity: 2,
    });
  });

  it('OUT whose guarded updateMany matches a row (down to zero) succeeds', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 1 });
    tx.consumableMovement.create.mockResolvedValue({ id: 3 });

    await service.createMovement('k1', { type: 'OUT', quantity: 4 });

    expect(tx.consumable.updateMany).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null, currentStock: { gte: 4 } },
      data: { currentStock: { decrement: 4 } },
    });
    expect(tx.consumableMovement.create).toHaveBeenCalledTimes(1);
  });

  it('OUT that matches no live row with enough stock (count 0) throws 409 and persists nothing', async () => {
    // The guarded decrement updated zero rows: insufficient stock under concurrency. The follow-up
    // findFirst proves the row exists, so this is a 409 (not a 404).
    tx.consumable.updateMany.mockResolvedValue({ count: 0 });
    tx.consumable.findFirst.mockResolvedValue({ currentStock: 1 });

    await expect(
      service.createMovement('k1', { type: 'OUT', quantity: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('OUT with count 0 against a missing/soft-deleted consumable throws 404', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 0 });
    tx.consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.createMovement('missing', { type: 'OUT', quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('ADJUSTMENT sets currentStock to the absolute quantity (even below current)', async () => {
    tx.consumable.update.mockResolvedValue({ id: 'k1' });
    tx.consumableMovement.create.mockResolvedValue({ id: 4 });

    await service.createMovement('k1', { type: 'ADJUSTMENT', quantity: 7 });

    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: 7 },
    });
  });

  it('IN whose result would exceed int4 (INT4_MAX) throws 409 and persists nothing', async () => {
    const INT4_MAX = 2_147_483_647;
    tx.consumable.findFirst.mockResolvedValue({ currentStock: INT4_MAX - 1 });

    await expect(
      service.createMovement('k1', { type: 'IN', quantity: 5 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('IN 404 when the consumable is missing — nothing is updated or recorded', async () => {
    tx.consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.createMovement('missing', { type: 'IN', quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  // --- createMovement: actor via the authenticated User -------------------
  it('resolves the actor and stamps performedById on the movement', async () => {
    actor.resolve.mockReturnValue(ACTOR_ID);
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 5 });

    await service.createMovement(
      'k1',
      { type: 'IN', quantity: 1, reason: 'restock', notes: 'box A' },
      ACTOR_USER as never,
    );

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_USER);
    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).toEqual({
      consumableId: 'k1',
      type: 'IN',
      quantity: 1,
      reason: 'restock',
      notes: 'box A',
      performedById: ACTOR_ID,
    });
  });

  it('leaves performedById absent when the actor resolves to undefined (no user)', async () => {
    actor.resolve.mockReturnValue(undefined);
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 6 });

    await service.createMovement('k1', { type: 'IN', quantity: 1 });

    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).not.toHaveProperty('performedById');
    expect(calls[0][0].data).not.toHaveProperty('reason');
    expect(calls[0][0].data).not.toHaveProperty('notes');
  });

  it('propagates a thrown error from the actor resolver and never opens the transaction', async () => {
    actor.resolve.mockImplementation(() => {
      throw new BadRequestException();
    });

    await expect(
      service.createMovement(
        'k1',
        { type: 'IN', quantity: 1 },
        ACTOR_USER as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // --- listMovements ------------------------------------------------------
  it('listMovements asserts the consumable exists then queries newest first', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumableMovement.findMany.mockResolvedValue([]);

    await service.listMovements('k1', {});

    expect(consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1' },
      select: { id: true },
    });
    expect(consumableMovement.findMany).toHaveBeenCalledWith({
      where: { consumableId: 'k1' },
      orderBy: { id: 'desc' },
    });
  });

  it('listMovements applies the type and createdAt-range filters', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumableMovement.findMany.mockResolvedValue([]);
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-02-01T00:00:00.000Z';

    await service.listMovements('k1', { type: 'OUT', from, to });

    expect(consumableMovement.findMany).toHaveBeenCalledWith({
      where: {
        consumableId: 'k1',
        type: 'OUT',
        createdAt: { gte: new Date(from), lte: new Date(to) },
      },
      orderBy: { id: 'desc' },
    });
  });

  it('listMovements with only `from` builds a half-open range', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumableMovement.findMany.mockResolvedValue([]);
    const from = '2026-01-01T00:00:00.000Z';

    await service.listMovements('k1', { from });

    expect(consumableMovement.findMany).toHaveBeenCalledWith({
      where: {
        consumableId: 'k1',
        createdAt: { gte: new Date(from) },
      },
      orderBy: { id: 'desc' },
    });
  });

  it('listMovements 404s when the consumable is missing (before querying)', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(service.listMovements('missing', {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consumableMovement.findMany).not.toHaveBeenCalled();
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt for a soft-deleted consumable', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1', deletedAt: new Date() });
    consumable.update.mockResolvedValue({ id: 'k1', deletedAt: null });

    const restored = await service.restore('k1');

    // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
    expect(consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1' },
      includeSoftDeleted: true,
    });
    expect(consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { deletedAt: null },
    });
    expect(restored.deletedAt).toBeNull();
  });

  it('restore is idempotent (no update) when the consumable is already live', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1', deletedAt: null });

    await service.restore('k1');

    expect(consumable.update).not.toHaveBeenCalled();
  });

  it('restore 404s when the consumable never existed', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
