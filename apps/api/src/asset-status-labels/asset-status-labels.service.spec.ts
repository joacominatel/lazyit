import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AssetStatusLabelsService } from './asset-status-labels.service';
import { ActorService } from '../common/actor.service';

jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

/**
 * Custom asset statuses (ADR-0101, #1524): the label lifecycle and the two rules that keep
 * `asset.status == label.kind` true — a kind change is refused while assets carry the label, and a delete
 * moves its assets (live and archived, with history) before archiving it, in one transaction.
 */

const ID = 'clabelrepair0000000000001';
const TARGET = 'clabelbench00000000000001';
const NOW = new Date('2026-10-05T12:00:00.000Z');
const ACTOR = { kind: 'human', user: { id: 'u-actor' } } as never;

const label = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  name: 'In repair at vendor',
  kind: 'IN_MAINTENANCE',
  color: null,
  description: null,
  order: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

function setup() {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    assetStatusLabel: {
      findFirst: jest.fn(),
      update: jest.fn(({ data }: { data: object }) => ({
        ...label(),
        ...data,
      })),
    },
    asset: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  const prisma = {
    assetStatusLabel: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(({ data }: { data: object }) => ({
        ...label(),
        ...data,
      })),
      update: jest.fn(({ data }: { data: object }) => ({
        ...label(),
        ...data,
      })),
    },
    asset: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  };
  const history = { record: jest.fn() };
  const search = { upsert: jest.fn() };
  const service = new AssetStatusLabelsService(
    prisma as never,
    new ActorService(),
    history as never,
    search as never,
  );
  return { service, prisma, tx, history, search };
}

/** The live row `findOne` reads (with its live asset count). */
const withCount = (count: number, overrides: Record<string, unknown> = {}) => ({
  ...label(overrides),
  _count: { assets: count },
});

describe('AssetStatusLabelsService — reads', () => {
  it('lists by kind (built-in order), then order (unset last), then name, with assetCount', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findMany.mockResolvedValue([
      { ...withCount(0, { id: 'c3', name: 'Zeta', kind: 'LOST' }) },
      { ...withCount(2, { id: 'c2', name: 'Beta', kind: 'OPERATIONAL' }) },
      {
        ...withCount(1, {
          id: 'c1',
          name: 'Alpha',
          kind: 'IN_MAINTENANCE',
          order: 5,
        }),
      },
      {
        ...withCount(0, {
          id: 'c4',
          name: 'Gamma',
          kind: 'IN_MAINTENANCE',
          order: 1,
        }),
      },
      { ...withCount(0, { id: 'c5', name: 'Aaa', kind: 'IN_MAINTENANCE' }) },
    ]);

    const rows = await service.findAll();

    expect(rows.map((r) => r.id)).toEqual(['c2', 'c4', 'c1', 'c5', 'c3']);
    expect(rows[0]).toMatchObject({ assetCount: 2 });
    expect(rows[0]).not.toHaveProperty('_count');
    expect(prisma.assetStatusLabel.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      include: {
        _count: { select: { assets: { where: { deletedAt: null } } } },
      },
    });
  });

  it('the archived slice carries the soft-delete escape hatch', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findMany.mockResolvedValue([]);
    await service.findAll('only');
    expect(prisma.assetStatusLabel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { deletedAt: { not: null } },
        includeSoftDeleted: true,
      }),
    );
  });

  it('findOne 404s a missing or archived label', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValue(null);
    await expect(service.findOne(ID)).rejects.toThrow(NotFoundException);
  });
});

describe('AssetStatusLabelsService — create and update', () => {
  it('creates a label; a live duplicate name is a 409', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(null);
    await service.create({ name: 'Loaner pool', kind: 'IN_STORAGE' });
    expect(prisma.assetStatusLabel.create).toHaveBeenCalledWith({
      data: { name: 'Loaner pool', kind: 'IN_STORAGE' },
    });

    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce({ id: 'other' });
    await expect(
      service.create({ name: 'Loaner pool', kind: 'IN_STORAGE' }),
    ).rejects.toThrow(ConflictException);
  });

  it('renames and recolours without touching any asset', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst
      .mockResolvedValueOnce(withCount(3)) // findOne
      .mockResolvedValueOnce(null); // name is free
    await service.update(ID, { name: 'At the vendor', color: '#000000' });
    expect(prisma.assetStatusLabel.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { name: 'At the vendor', color: '#000000' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('a kind change on an UNUSED label goes through, under the label lock', async () => {
    const { service, prisma, tx } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(0));
    tx.assetStatusLabel.findFirst.mockResolvedValue(label());
    tx.asset.count.mockResolvedValue(0);

    await service.update(ID, { kind: 'RETIRED' });

    const sql = (tx.$queryRaw.mock.calls as [string[]][])[0][0].join('?');
    expect(sql).toContain('FOR UPDATE');
    expect(tx.asset.count).toHaveBeenCalledWith({
      where: { statusLabelId: ID },
      includeSoftDeleted: true,
    });
    expect(tx.assetStatusLabel.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { kind: 'RETIRED' },
    });
  });

  it('a kind change while ANY asset (archived included) carries the label is a 409', async () => {
    const { service, prisma, tx } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(0));
    tx.assetStatusLabel.findFirst.mockResolvedValue(label());
    tx.asset.count.mockResolvedValue(1); // one ARCHIVED asset: assetCount (live) is 0

    await expect(service.update(ID, { kind: 'RETIRED' })).rejects.toThrow(
      ConflictException,
    );
    expect(tx.assetStatusLabel.update).not.toHaveBeenCalled();
  });

  it('re-sending the current kind is not a kind change', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(9));
    await service.update(ID, { kind: 'IN_MAINTENANCE' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.assetStatusLabel.update).toHaveBeenCalled();
  });
});

describe('AssetStatusLabelsService — delete with reassign', () => {
  const carriers = [
    { id: 'a1', status: 'IN_MAINTENANCE', deletedAt: null },
    { id: 'a2', status: 'IN_MAINTENANCE', deletedAt: NOW },
  ];

  it('an unused label is simply archived (no target needed)', async () => {
    const { service, prisma, tx, history } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(0));
    tx.assetStatusLabel.findFirst.mockResolvedValue(label());

    const result = await service.remove(ID, {}, ACTOR);

    expect(tx.asset.updateMany).not.toHaveBeenCalled();
    expect(history.record).not.toHaveBeenCalled();
    expect(tx.assetStatusLabel.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { deletedAt: expect.any(Date) as Date },
    });
    expect(result.movedAssetCount).toBe(0);
  });

  it('a label in use without a target is a 400 and nothing changes', async () => {
    const { service, prisma, tx } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(1));
    tx.assetStatusLabel.findFirst.mockResolvedValue(label());
    tx.asset.findMany.mockResolvedValue(carriers);

    await expect(service.remove(ID, {}, ACTOR)).rejects.toThrow(
      /choose where they go/,
    );
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
    expect(tx.assetStatusLabel.update).not.toHaveBeenCalled();
  });

  it('moves every carrier (live and archived) to a built-in status, with history, then archives', async () => {
    const { service, prisma, tx, history, search } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(1));
    tx.assetStatusLabel.findFirst.mockResolvedValue(label());
    tx.asset.findMany.mockResolvedValue(carriers);
    prisma.asset.findMany.mockResolvedValue([
      { id: 'a1', name: 'L', serial: null, assetTag: null, status: 'RETIRED' },
    ]);

    const result = await service.remove(
      ID,
      { reassignStatus: 'RETIRED' },
      ACTOR,
    );

    expect(tx.asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { statusLabelId: ID },
        includeSoftDeleted: true,
      }),
    );
    expect(tx.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { status: 'RETIRED', statusLabelId: null },
    });
    expect(history.record).toHaveBeenCalledTimes(2);
    expect(history.record).toHaveBeenCalledWith(tx, {
      assetId: 'a2',
      eventType: 'STATUS_CHANGED',
      payload: {
        from: 'IN_MAINTENANCE',
        to: 'RETIRED',
        fromLabel: { id: ID, name: 'In repair at vendor' },
        toLabel: null,
      },
      actor: { userId: 'u-actor' },
    });
    // Only the LIVE moved asset is re-indexed (archived assets are not in the search index).
    expect(prisma.asset.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] } },
    });
    expect(search.upsert).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ movedAssetCount: 2 });
    expect(result.deletedAt).toBeInstanceOf(Date);
  });

  it('moves the carriers to another live custom status (its kind becomes their status)', async () => {
    const { service, prisma, tx, history } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(withCount(1));
    tx.assetStatusLabel.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        where.id === ID
          ? label()
          : {
              id: TARGET,
              name: 'Loaner pool',
              kind: 'IN_STORAGE',
              color: null,
            },
    );
    tx.asset.findMany.mockResolvedValue([carriers[0]]);

    await service.remove(ID, { reassignLabelId: TARGET }, ACTOR);

    // The deleted label is locked FOR UPDATE, the target FOR SHARE.
    const locks = tx.$queryRaw.mock.calls.map(([sql]) =>
      (sql as string[]).join('?'),
    );
    expect(locks[0]).toContain('FOR UPDATE');
    expect(locks[1]).toContain('FOR SHARE');
    expect(tx.asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] } },
      data: { status: 'IN_STORAGE', statusLabelId: TARGET },
    });
    expect(history.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payload: {
          from: 'IN_MAINTENANCE',
          to: 'IN_STORAGE',
          fromLabel: { id: ID, name: 'In repair at vendor' },
          toLabel: { id: TARGET, name: 'Loaner pool' },
        },
      }),
    );
  });

  it('refuses an archived target label, the label itself, and both targets at once', async () => {
    const { service, prisma, tx } = setup();
    prisma.assetStatusLabel.findFirst.mockResolvedValue(withCount(1));
    tx.assetStatusLabel.findFirst.mockImplementation(
      ({ where }: { where: { id: string } }) =>
        where.id === ID ? label() : null,
    );
    tx.asset.findMany.mockResolvedValue(carriers);

    await expect(
      service.remove(ID, { reassignLabelId: TARGET }, ACTOR),
    ).rejects.toThrow(/missing or archived/);
    await expect(
      service.remove(ID, { reassignLabelId: ID }, ACTOR),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.remove(
        ID,
        { reassignLabelId: TARGET, reassignStatus: 'LOST' },
        ACTOR,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(tx.asset.updateMany).not.toHaveBeenCalled();
  });
});

describe('AssetStatusLabelsService — restore', () => {
  it('restores an archived label (idempotent when live; 404 when unknown)', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst
      .mockResolvedValueOnce(label({ deletedAt: NOW })) // the archived row
      .mockResolvedValueOnce(null); // its name is free
    await service.restore(ID);
    expect(prisma.assetStatusLabel.update).toHaveBeenCalledWith({
      where: { id: ID },
      data: { deletedAt: null },
    });

    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(label());
    await expect(service.restore(ID)).resolves.toMatchObject({ id: ID });

    prisma.assetStatusLabel.findFirst.mockResolvedValueOnce(null);
    await expect(service.restore(ID)).rejects.toThrow(NotFoundException);
  });

  it('a restore whose name a live label took meanwhile is a 409', async () => {
    const { service, prisma } = setup();
    prisma.assetStatusLabel.findFirst
      .mockResolvedValueOnce(label({ deletedAt: NOW }))
      .mockResolvedValueOnce({ id: 'clive' });
    await expect(service.restore(ID)).rejects.toThrow(ConflictException);
  });
});
