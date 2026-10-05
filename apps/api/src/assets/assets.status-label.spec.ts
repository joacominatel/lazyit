import { BadRequestException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { ActorService } from '../common/actor.service';

// No DB: the generated client is stubbed (the service only needs its types at runtime), and the ESM
// `meilisearch` package SearchService imports is never loaded.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * Custom asset statuses on every asset write path (ADR-0101, #1524). The invariant under test:
 * `asset.statusLabelId != null ⇒ asset.status == label.kind`, kept by deriving `status` from the label on
 * every write, and the `STATUS_CHANGED` history that also fires when only the custom status changes.
 */

const LABEL = {
  id: 'clabelrepair0000000000001',
  name: 'In repair at vendor',
  kind: 'IN_MAINTENANCE' as const,
  color: '#F59E0B',
};
const OTHER = {
  id: 'clabelbench00000000000001',
  name: 'On the bench',
  kind: 'IN_MAINTENANCE' as const,
  color: null,
};
const ACTOR = { kind: 'human', user: { id: 'u-actor' } } as never;

type Mock = jest.Mock;

function setup() {
  const labels = new Map<string, typeof LABEL | typeof OTHER>([
    [LABEL.id, LABEL],
    [OTHER.id, OTHER],
  ]);
  const findLabel: Mock = jest.fn(
    ({ where }: { where: { id: string } }) =>
      Promise.resolve(labels.get(where.id) ?? null) as Promise<unknown>,
  );
  const tx = {
    asset: { create: jest.fn(), update: jest.fn() },
    assetModel: { findFirst: jest.fn() },
    location: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) },
    assetStatusLabel: { findFirst: findLabel },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    asset: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
    },
    assetModel: { findFirst: jest.fn() },
    location: tx.location,
    assetStatusLabel: { findFirst: findLabel },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (client: typeof tx) => unknown)(tx),
    ),
  };
  const history = { record: jest.fn() };
  const search = { upsert: jest.fn(), remove: jest.fn() };
  const tagScheme = { allocateTag: jest.fn().mockResolvedValue(undefined) };
  const permissions = { principalHas: jest.fn().mockResolvedValue(false) };
  const service = new AssetsService(
    prisma as never,
    new ActorService(),
    history as never,
    search as never,
    tagScheme as never,
    permissions as never,
  );
  const events = () =>
    history.record.mock.calls.map(
      ([, event]) =>
        event as { assetId: string; eventType: string; payload?: unknown },
    );
  return { service, prisma, tx, history, labels, events };
}

describe('AssetsService — custom statuses on create (ADR-0101)', () => {
  it('derives the built-in status from the custom status and locks the label FOR SHARE', async () => {
    const { service, tx } = setup();
    tx.asset.create.mockImplementation(({ data }: { data: object }) => ({
      id: 'a1',
      purchaseCost: null,
      salvageValue: null,
      ...data,
    }));

    await service.create({ name: 'Laptop', statusLabelId: LABEL.id }, ACTOR);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (tx.$queryRaw.mock.calls as [string[]][])[0][0].join('?');
    expect(sql).toContain('FOR SHARE');
    expect(tx.asset.create).toHaveBeenCalledWith({
      data: {
        name: 'Laptop',
        status: 'IN_MAINTENANCE',
        statusLabelId: LABEL.id,
      },
    });
  });

  it('accepts a status that agrees with the custom status', async () => {
    const { service, tx } = setup();
    tx.asset.create.mockResolvedValue({
      id: 'a1',
      purchaseCost: null,
      salvageValue: null,
    });
    await service.create({
      name: 'Laptop',
      status: 'IN_MAINTENANCE',
      statusLabelId: LABEL.id,
    });
    expect(tx.asset.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a status of another kind than the custom status (400)', async () => {
    const { service, tx } = setup();
    await expect(
      service.create({
        name: 'Laptop',
        status: 'OPERATIONAL',
        statusLabelId: LABEL.id,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(tx.asset.create).not.toHaveBeenCalled();
  });

  it('refuses a missing or archived custom status (400)', async () => {
    const { service, tx, labels } = setup();
    labels.delete(LABEL.id);
    await expect(
      service.create({ name: 'Laptop', statusLabelId: LABEL.id }),
    ).rejects.toThrow(/not found \(missing or archived\)/);
    expect(tx.asset.create).not.toHaveBeenCalled();
  });

  it('keeps a bare built-in status create exactly as before (no label, no lock)', async () => {
    const { service, tx } = setup();
    tx.asset.create.mockResolvedValue({
      id: 'a1',
      purchaseCost: null,
      salvageValue: null,
    });
    await service.create({ name: 'Laptop', status: 'IN_STORAGE' });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.asset.create).toHaveBeenCalledWith({
      data: { name: 'Laptop', status: 'IN_STORAGE' },
    });
  });

  it('an internal caller with neither status nor custom status is a 400', async () => {
    const { service } = setup();
    await expect(service.create({ name: 'Laptop' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('AssetsService — custom statuses on update (ADR-0101)', () => {
  const before = (overrides: Record<string, unknown> = {}) => ({
    id: 'a1',
    status: 'IN_MAINTENANCE',
    statusLabelId: LABEL.id,
    statusLabel: { id: LABEL.id, name: LABEL.name },
    locationId: null,
    modelId: null,
    specs: null,
    ...overrides,
  });
  /** tx.asset.update echoes the before row with the written data applied. */
  function echo(tx: ReturnType<typeof setup>['tx'], row: object) {
    tx.asset.update.mockImplementation(({ data }: { data: object }) => ({
      ...row,
      purchaseCost: null,
      salvageValue: null,
      ...data,
    }));
  }

  it('status alone, equal to the current one, keeps the custom status (no event)', async () => {
    const { service, prisma, tx, events } = setup();
    prisma.asset.findFirst.mockResolvedValue(before());
    echo(tx, before());

    await service.update('a1', { status: 'IN_MAINTENANCE' });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'IN_MAINTENANCE' },
    });
    expect(events().filter((e) => e.eventType === 'STATUS_CHANGED')).toEqual(
      [],
    );
  });

  it('status alone, to another status, clears the custom status and names it in the history', async () => {
    const { service, prisma, tx, events } = setup();
    prisma.asset.findFirst.mockResolvedValue(before());
    echo(tx, before());

    await service.update('a1', { status: 'OPERATIONAL' });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'OPERATIONAL', statusLabelId: null },
    });
    expect(events()).toContainEqual(
      expect.objectContaining({
        eventType: 'STATUS_CHANGED',
        payload: {
          from: 'IN_MAINTENANCE',
          to: 'OPERATIONAL',
          fromLabel: { id: LABEL.id, name: LABEL.name },
          toLabel: null,
        },
      }),
    );
  });

  it('a label-only change (same built-in status) still writes STATUS_CHANGED', async () => {
    const { service, prisma, tx, events } = setup();
    prisma.asset.findFirst.mockResolvedValue(before());
    echo(tx, before());

    await service.update('a1', { statusLabelId: OTHER.id });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'IN_MAINTENANCE', statusLabelId: OTHER.id },
    });
    expect(events()).toEqual([
      expect.objectContaining({
        eventType: 'STATUS_CHANGED',
        payload: {
          from: 'IN_MAINTENANCE',
          to: 'IN_MAINTENANCE',
          fromLabel: { id: LABEL.id, name: LABEL.name },
          toLabel: { id: OTHER.id, name: OTHER.name },
        },
      }),
    ]);
  });

  it('setting a custom status from a bare status sets its kind as the status', async () => {
    const { service, prisma, tx, events } = setup();
    const bare = before({
      status: 'OPERATIONAL',
      statusLabelId: null,
      statusLabel: null,
    });
    prisma.asset.findFirst.mockResolvedValue(bare);
    echo(tx, bare);

    await service.update('a1', { statusLabelId: LABEL.id });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'IN_MAINTENANCE', statusLabelId: LABEL.id },
    });
    expect(events()[0].payload).toEqual({
      from: 'OPERATIONAL',
      to: 'IN_MAINTENANCE',
      fromLabel: null,
      toLabel: { id: LABEL.id, name: LABEL.name },
    });
  });

  it('statusLabelId: null clears the custom status and keeps the built-in status', async () => {
    const { service, prisma, tx, events } = setup();
    prisma.asset.findFirst.mockResolvedValue(before());
    echo(tx, before());

    await service.update('a1', { statusLabelId: null });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { statusLabelId: null },
    });
    expect(events()[0].payload).toEqual({
      from: 'IN_MAINTENANCE',
      to: 'IN_MAINTENANCE',
      fromLabel: { id: LABEL.id, name: LABEL.name },
      toLabel: null,
    });
  });

  it('refuses an archived custom status (400) and a disagreeing status (400)', async () => {
    const { service, prisma, labels, tx } = setup();
    prisma.asset.findFirst.mockResolvedValue(before());
    labels.delete(OTHER.id);
    await expect(
      service.update('a1', { statusLabelId: OTHER.id }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.update('a1', { statusLabelId: LABEL.id, status: 'LOST' }),
    ).rejects.toThrow(/does not match the custom status/);
    expect(tx.asset.update).not.toHaveBeenCalled();
  });

  it('a change between two bare statuses keeps the legacy { from, to } payload', async () => {
    const { service, prisma, tx, events } = setup();
    const bare = before({
      status: 'OPERATIONAL',
      statusLabelId: null,
      statusLabel: null,
    });
    prisma.asset.findFirst.mockResolvedValue(bare);
    echo(tx, bare);

    await service.update('a1', { status: 'RETIRED' });

    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED' },
    });
    expect(events()[0].payload).toEqual({ from: 'OPERATIONAL', to: 'RETIRED' });
  });
});

describe('AssetsService — custom statuses in bulk (ADR-0101)', () => {
  const rows = [
    {
      id: 'a1',
      status: 'IN_MAINTENANCE',
      statusLabelId: LABEL.id,
      statusLabel: { id: LABEL.id, name: LABEL.name },
    },
    {
      id: 'a2',
      status: 'OPERATIONAL',
      statusLabelId: null,
      statusLabel: null,
    },
    {
      id: 'a3',
      status: 'IN_MAINTENANCE',
      statusLabelId: OTHER.id,
      statusLabel: { id: OTHER.id, name: OTHER.name },
    },
  ];

  it('batch status to a custom status: skips assets already there, writes the label and its kind', async () => {
    const { service, prisma, tx, events } = setup();
    prisma.asset.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);

    const result = await service.batchSetStatus(
      ['a1', 'a2', 'a3', 'a4'],
      { statusLabelId: LABEL.id },
      ACTOR,
    );

    expect(result.succeeded).toEqual(['a2', 'a3']);
    expect(result.skipped).toEqual([
      { id: 'a1', reason: 'already_in_state' },
      { id: 'a4', reason: 'not_found' },
    ]);
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a2' },
      data: { status: 'IN_MAINTENANCE', statusLabelId: LABEL.id },
    });
    expect(events().map((e) => e.payload)).toEqual([
      {
        from: 'OPERATIONAL',
        to: 'IN_MAINTENANCE',
        fromLabel: null,
        toLabel: { id: LABEL.id, name: LABEL.name },
      },
      {
        from: 'IN_MAINTENANCE',
        to: 'IN_MAINTENANCE',
        fromLabel: { id: OTHER.id, name: OTHER.name },
        toLabel: { id: LABEL.id, name: LABEL.name },
      },
    ]);
  });

  it('batch status to a built-in status: keeps the label of an asset already in it, clears it on a change', async () => {
    const { service, prisma, tx } = setup();
    prisma.asset.findMany.mockResolvedValueOnce(rows).mockResolvedValue([]);

    const result = await service.batchSetStatus(['a1', 'a2'], {
      status: 'IN_MAINTENANCE',
    });

    expect(result.skipped).toEqual([{ id: 'a1', reason: 'already_in_state' }]);
    expect(tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a2' },
      data: { status: 'IN_MAINTENANCE' },
    });

    const second = setup();
    second.prisma.asset.findMany
      .mockResolvedValueOnce(rows)
      .mockResolvedValue([]);
    await second.service.batchSetStatus(['a1'], { status: 'RETIRED' });
    expect(second.tx.asset.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { status: 'RETIRED', statusLabelId: null },
    });
  });

  it('batch status refuses an archived custom status and a disagreeing status up front', async () => {
    const { service, labels, prisma } = setup();
    await expect(
      service.batchSetStatus(['a1'], {
        statusLabelId: LABEL.id,
        status: 'LOST',
      }),
    ).rejects.toThrow(BadRequestException);
    labels.delete(LABEL.id);
    await expect(
      service.batchSetStatus(['a1'], { statusLabelId: LABEL.id }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('bulk receive refuses an archived custom status once, before any unit', async () => {
    const { service, prisma, labels, tx } = setup();
    prisma.assetModel.findFirst.mockResolvedValue({ name: 'Latitude' });
    labels.delete(LABEL.id);
    await expect(
      service.receiveBatch({
        modelId: 'cmodel0000000000000000001',
        quantity: 3,
        statusLabelId: LABEL.id,
      }),
    ).rejects.toThrow(/not found/);
    expect(tx.asset.create).not.toHaveBeenCalled();
  });

  it('bulk receive passes the custom status to every unit', async () => {
    const { service, prisma, tx } = setup();
    prisma.assetModel.findFirst.mockResolvedValue({ name: 'Latitude' });
    tx.assetModel.findFirst.mockResolvedValue({ specs: null });
    tx.asset.create.mockImplementation(({ data }: { data: object }) => ({
      id: 'a',
      purchaseCost: null,
      salvageValue: null,
      ...data,
    }));
    const result = await service.receiveBatch({
      modelId: 'cmodel0000000000000000001',
      quantity: 2,
      statusLabelId: LABEL.id,
    });
    expect(result.failed).toEqual([]);
    for (const [{ data }] of tx.asset.create.mock.calls as [
      { data: Record<string, unknown> },
    ][]) {
      expect(data).toMatchObject({
        status: 'IN_MAINTENANCE',
        statusLabelId: LABEL.id,
      });
    }
  });
});

describe('AssetsService — the statusLabelId list filter (ADR-0101)', () => {
  it('filters by the exact custom status, AND-combined with the built-in status', async () => {
    const { service, prisma } = setup();
    prisma.asset.findMany.mockResolvedValue([]);
    prisma.asset.count.mockResolvedValue(0);
    await service.findPage(
      { statusLabelId: LABEL.id, status: 'IN_MAINTENANCE' },
      { limit: 50, offset: 0, deleted: 'active' } as never,
    );
    const [args] = prisma.asset.findMany.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({
      statusLabelId: LABEL.id,
      status: 'IN_MAINTENANCE',
    });
  });
});
