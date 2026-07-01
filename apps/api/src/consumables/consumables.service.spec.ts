import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ConsumablesService } from './consumables.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SearchService } from '../search/search.service';

// Jest can't transform the ESM-only `meilisearch` package; ConsumablesService transitively imports it
// via SearchService, so stub the module out (we never construct a real client in these tests).
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

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

// A well-formed UUID used as the human actor, and a service-account id (ADR-0048).
const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
const SA_ID = 'sa_abcdefghijklmnopqrstuvwx';
// The unified principals — only the actor id drives attribution; cast through `never`.
const HUMAN_PRINCIPAL = { kind: 'human', user: { id: ACTOR_ID } } as never;
const SA_PRINCIPAL = {
  kind: 'service',
  serviceAccount: { id: SA_ID },
  permissions: new Set(),
} as never;

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
  let actor: ActorService;
  let notifications: { emit: jest.Mock };
  let search: { upsert: jest.Mock; remove: jest.Mock };

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
    // ActorService is a pure resolver (the guard already validated the principal); the real instance is
    // used so it produces the genuine ActorAttribution from the principal each test passes (ADR-0048).
    actor = new ActorService();

    notifications = { emit: jest.fn().mockResolvedValue(null) };

    // Fire-and-forget search sync (ADR-0035): upsert/remove are no-op jest.fns here (no live Meili).
    search = { upsert: jest.fn(), remove: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ConsumablesService,
        { provide: PrismaService, useValue: prisma },
        { provide: ActorService, useValue: actor },
        { provide: NotificationsService, useValue: notifications },
        { provide: SearchService, useValue: search },
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

  it('findPage filters by categoryId when set', async () => {
    consumable.findMany.mockResolvedValue([]);
    consumable.count.mockResolvedValue(0);

    await service.findPage(
      { categoryId: 'cat1' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      consumable.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({ categoryId: 'cat1', deletedAt: null });
    // The count query must filter on the SAME where so total matches the page.
    const countCall = (
      consumable.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(countCall.where).toEqual({ categoryId: 'cat1', deletedAt: null });
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
    // Consumable is NOT in SOFT_DELETABLE_MODELS, so the by-id read scopes to live rows EXPLICITLY
    // (SEC-050): a soft-deleted consumable must 404, not leak. The read filter does not auto-scope it.
    expect(consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
    });
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

    // The write gate (assertExists) is live-scoped (SEC-050): editing a soft-deleted consumable 404s.
    expect(consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
      select: { id: true },
    });
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
    // The pre-read is live-scoped (SEC-050): a soft-deleted consumable reads as null → 404, never
    // incremented. Then the write is an atomic increment, not a JS read-modify-write of an absolute.
    expect(tx.consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
      select: { currentStock: true },
    });
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
    // The disambiguation read scopes to live rows (SEC-050) so it only ever echoes a LIVE row's stock.
    expect(tx.consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
      select: { currentStock: true },
    });
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('OUT with count 0 against a missing/soft-deleted consumable throws 404', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 0 });
    // The disambiguation read is live-scoped, so a soft-deleted row reads as null → 404 (not a stock
    // leak): the guarded updateMany already carries deletedAt: null, so it never matched it (SEC-050).
    tx.consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.createMovement('missing', { type: 'OUT', quantity: 1 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'missing', deletedAt: null },
      select: { currentStock: true },
    });
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  it('ADJUSTMENT sets currentStock to the absolute quantity (even below current) via a live-guarded updateMany', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 1 });
    tx.consumableMovement.create.mockResolvedValue({ id: 4 });

    await service.createMovement('k1', { type: 'ADJUSTMENT', quantity: 7 });

    // Guarded updateMany scoped to the live row (SEC-050): an absolute recount can't resurrect a
    // soft-deleted consumable. The plain `update` would have hit the archived row (it still exists).
    expect(tx.consumable.updateMany).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
      data: { currentStock: 7 },
    });
    expect(tx.consumable.update).not.toHaveBeenCalled();
  });

  it('ADJUSTMENT against a missing/soft-deleted consumable (count 0) throws 404 and persists nothing (SEC-050)', async () => {
    tx.consumable.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.createMovement('gone', { type: 'ADJUSTMENT', quantity: 7 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
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

  it('IN against a soft-deleted consumable 404s — the live-scoped pre-read returns null (SEC-050)', async () => {
    // The live-scoped pre-read (`deletedAt: null`) means a soft-deleted row reads as null → 404, so
    // no increment runs and no ledger row is appended to an archived consumable.
    tx.consumable.findFirst.mockResolvedValue(null);

    await expect(
      service.createMovement('archived', { type: 'IN', quantity: 100 }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'archived', deletedAt: null },
      select: { currentStock: true },
    });
    expect(tx.consumable.update).not.toHaveBeenCalled();
    expect(tx.consumableMovement.create).not.toHaveBeenCalled();
  });

  // --- createMovement: actor via the unified principal (ADR-0048) ---------
  it('resolves a HUMAN principal and stamps performedById on the movement', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 5 });

    await service.createMovement(
      'k1',
      { type: 'IN', quantity: 1, reason: 'restock', notes: 'box A' },
      HUMAN_PRINCIPAL,
    );

    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    // A human → performedById, never serviceAccountId (behavior-preserving).
    expect(calls[0][0].data).toEqual({
      consumableId: 'k1',
      type: 'IN',
      quantity: 1,
      reason: 'restock',
      notes: 'box A',
      performedById: ACTOR_ID,
    });
  });

  it('resolves a SERVICE-ACCOUNT principal and stamps serviceAccountId (performedById stays null) — ADR-0048', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 7 });

    await service.createMovement(
      'k1',
      { type: 'IN', quantity: 1 },
      SA_PRINCIPAL,
    );

    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).toEqual({
      consumableId: 'k1',
      type: 'IN',
      quantity: 1,
      serviceAccountId: SA_ID,
    });
    expect(calls[0][0].data).not.toHaveProperty('performedById');
  });

  it('leaves both actor columns absent when there is no principal (anonymous/system)', async () => {
    tx.consumable.findFirst.mockResolvedValue({ id: 'k1', currentStock: 0 });
    tx.consumableMovement.create.mockResolvedValue({ id: 6 });

    await service.createMovement('k1', { type: 'IN', quantity: 1 });

    const calls = tx.consumableMovement.create.mock
      .calls as CreateMovementCall[];
    expect(calls[0][0].data).not.toHaveProperty('performedById');
    expect(calls[0][0].data).not.toHaveProperty('serviceAccountId');
    expect(calls[0][0].data).not.toHaveProperty('reason');
    expect(calls[0][0].data).not.toHaveProperty('notes');
  });

  // --- listMovements ------------------------------------------------------
  it('listMovements asserts the consumable exists then queries newest first', async () => {
    consumable.findFirst.mockResolvedValue({ id: 'k1' });
    consumableMovement.findMany.mockResolvedValue([]);

    await service.listMovements('k1', {});

    // assertExists scopes to live rows (SEC-050): listing the ledger of a soft-deleted consumable 404s.
    expect(consumable.findFirst).toHaveBeenCalledWith({
      where: { id: 'k1', deletedAt: null },
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

  // --- search sync (#873) --------------------------------------------------
  describe('search sync (ADR-0035, #873)', () => {
    // A full live row + its projected search document (id/name/sku/description/currentStock/unit).
    const FULL_ROW = {
      id: 'k1',
      name: 'HDMI cable',
      sku: 'HDMI-2M',
      description: '2m cable',
      currentStock: 12,
      unit: 'units',
      minStock: null, // null so the movement path's low-stock check is a clean early-return
    };
    const DOC = {
      id: 'k1',
      name: 'HDMI cable',
      sku: 'HDMI-2M',
      description: '2m cable',
      currentStock: 12,
      unit: 'units',
    };

    it('create upserts the projected consumable into the index', async () => {
      consumable.create.mockResolvedValue(FULL_ROW);

      await service.create({ name: 'HDMI cable', unit: 'units' });

      expect(search.upsert).toHaveBeenCalledWith('consumables', DOC);
    });

    it('update re-upserts after a successful edit', async () => {
      consumable.findFirst.mockResolvedValue({ id: 'k1' });
      consumable.update.mockResolvedValue(FULL_ROW);

      await service.update('k1', { name: 'HDMI cable' });

      expect(search.upsert).toHaveBeenCalledWith('consumables', DOC);
    });

    it('soft-delete removes the consumable from the index (never upserts)', async () => {
      consumable.findFirst.mockResolvedValue({ id: 'k1' });
      consumable.update.mockResolvedValue({ id: 'k1', deletedAt: new Date() });

      await service.remove('k1');

      expect(search.remove).toHaveBeenCalledWith('consumables', 'k1');
      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('restore re-upserts the reactivated consumable', async () => {
      consumable.findFirst.mockResolvedValue({
        ...FULL_ROW,
        deletedAt: new Date(),
      });
      consumable.update.mockResolvedValue({ ...FULL_ROW, deletedAt: null });

      await service.restore('k1');

      expect(search.upsert).toHaveBeenCalledWith('consumables', DOC);
    });

    it('restore is a search no-op when the consumable is already live (idempotent)', async () => {
      consumable.findFirst.mockResolvedValue({ ...FULL_ROW, deletedAt: null });

      await service.restore('k1');

      expect(search.upsert).not.toHaveBeenCalled();
    });

    it('re-indexes after a movement commits so the cached currentStock stays fresh', async () => {
      // IN tx path (increment).
      tx.consumable.findFirst.mockResolvedValue({ currentStock: 9 });
      tx.consumable.update.mockResolvedValue({ id: 'k1' });
      tx.consumableMovement.create.mockResolvedValue({ id: 1 });
      // The post-commit reindex (and the low-stock `before` read) go through the top-level findFirst.
      consumable.findFirst.mockResolvedValue(FULL_ROW);

      await service.createMovement('k1', { type: 'IN', quantity: 3 });
      // reindex is fire-and-forget (un-awaited .then) — flush the microtask queue so it runs.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(search.upsert).toHaveBeenCalledWith('consumables', DOC);
    });
  });
});
