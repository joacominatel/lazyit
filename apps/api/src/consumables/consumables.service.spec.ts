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
  // Field reference used by the lowStock filter (prisma.consumable.fields.minStock).
  fields: { minStock: unknown };
};

type MovementModelMock = {
  findMany: jest.Mock;
  create: jest.Mock;
};

// The transaction client the movement goes through; $transaction runs the callback with it.
type TxMock = {
  consumable: { findFirst: jest.Mock; update: jest.Mock };
  consumableMovement: { create: jest.Mock };
};

type MovementData = Record<string, unknown>;
type CreateMovementCall = [{ data: MovementData }];
type StockUpdateCall = [
  { where: { id: string }; data: { currentStock: number } },
];

// A sentinel object standing in for the Prisma FieldRef; we only assert identity.
const MIN_STOCK_FIELD = { __fieldRef: 'minStock' };

// A well-formed UUID used as the X-User-Id actor in the shim tests.
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';

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
      fields: { minStock: MIN_STOCK_FIELD },
    };
    consumableMovement = { findMany: jest.fn(), create: jest.fn() };
    tx = {
      consumable: { findFirst: jest.fn(), update: jest.fn() },
      consumableMovement: { create: jest.fn() },
    };
    prisma = {
      consumable,
      consumableMovement,
      $transaction: jest.fn((cb: (client: TxMock) => unknown) => cb(tx)),
    };
    // ActorService is mocked; shim-validation detail lives in actor.service.spec.ts. Default: no actor.
    actor = { resolve: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsumablesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
      ],
    }).compile();

    service = moduleRef.get(ConsumablesService);
  });

  // --- findAll ------------------------------------------------------------
  it('findAll lists by name asc with no filter by default', async () => {
    consumable.findMany.mockResolvedValue([]);

    await service.findAll();

    expect(consumable.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { name: 'asc' },
    });
  });

  it('findAll lowStock compares currentStock against the minStock field reference', async () => {
    consumable.findMany.mockResolvedValue([]);

    await service.findAll({ lowStock: true });

    expect(consumable.findMany).toHaveBeenCalledWith({
      where: {
        minStock: { not: null },
        currentStock: { lte: MIN_STOCK_FIELD },
      },
      orderBy: { name: 'asc' },
    });
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
    expect((calls[0][0].data as { deletedAt: Date }).deletedAt).toBeInstanceOf(
      Date,
    );
  });

  it('does not soft-delete a missing consumable', async () => {
    consumable.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(consumable.update).not.toHaveBeenCalled();
  });

  // --- createMovement: stock math -----------------------------------------
  it('IN adds to currentStock and persists the movement in a transaction', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 5 });
    tx.consumableMovement.create.mockResolvedValue({ id: 1 });

    await service.createMovement('k1', { type: 'IN', quantity: 3 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: 8 },
    });
    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).toMatchObject({
      consumableId: 'k1',
      type: 'IN',
      quantity: 3,
    });
  });

  it('OUT subtracts from currentStock', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 5 });
    tx.consumableMovement.create.mockResolvedValue({ id: 2 });

    await service.createMovement('k1', { type: 'OUT', quantity: 2 });

    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: 3 },
    });
  });

  it('OUT to exactly zero is allowed', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 4 });
    tx.consumableMovement.create.mockResolvedValue({ id: 3 });

    await service.createMovement('k1', { type: 'OUT', quantity: 4 });

    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: 0 },
    });
  });

  it('OUT that would go negative throws 409 and persists nothing', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 1 });

    await expect(
      service.createMovement('k1', { type: 'OUT', quantity: 2 }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('ADJUSTMENT sets currentStock to the absolute quantity (even below current)', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 50 });
    tx.consumableMovement.create.mockResolvedValue({ id: 4 });

    await service.createMovement('k1', { type: 'ADJUSTMENT', quantity: 7 });

    expect(tx.consumable.update).toHaveBeenCalledWith({
      where: { id: 'k1' },
      data: { currentStock: 7 },
    });
  });

  it('404 when the consumable is missing — nothing is updated or recorded', async () => {
    tx.consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.createMovement('missing', { type: 'IN', quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  // --- createMovement: actor via the X-User-Id shim -----------------------
  it('resolves the actor and stamps performedById on the movement', async () => {
    actor.resolve.mockResolvedValue(ACTOR_ID);
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 5 });

    await service.createMovement(
      'k1',
      { type: 'IN', quantity: 1, reason: 'restock', notes: 'box A' },
      ACTOR_ID,
    );

    expect(actor.resolve).toHaveBeenCalledWith(ACTOR_ID);
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

  it('leaves performedById absent when the actor resolves to undefined (no header)', async () => {
    actor.resolve.mockResolvedValue(undefined);
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 6 });

    await service.createMovement('k1', { type: 'IN', quantity: 1 });

    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).not.toHaveProperty('performedById');
    expect(calls[0][0].data).not.toHaveProperty('reason');
    expect(calls[0][0].data).not.toHaveProperty('notes');
  });

  it('propagates a BadRequest from the actor shim and never opens the transaction', async () => {
    actor.resolve.mockRejectedValue(new BadRequestException());

    await expect(
      service.createMovement('k1', { type: 'IN', quantity: 1 }, 'not-a-uuid'),
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
});
