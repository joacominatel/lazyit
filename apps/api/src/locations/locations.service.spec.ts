import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { LocationsService } from './locations.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { ActorService } from '../common/actor.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { PermissionResolverService } from '../auth/permission-resolver.service';

// Mock the generated Prisma client so the test never loads the real one (no DB).
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => values,
    empty: { strings: [''], values: [] },
  },
}));
// LocationsService transitively imports the ESM `meilisearch` package (via SearchService); jest
// can't transform it. SearchService is replaced by a mock below; this stub stops the real load.
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

type PrismaLocationMock = {
  findMany: jest.Mock;
  findFirst: jest.Mock;
  create: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  count: jest.Mock;
};

type SearchMock = { upsert: jest.Mock; remove: jest.Mock; search: jest.Mock };

describe('LocationsService', () => {
  let service: LocationsService;
  let location: PrismaLocationMock;
  let search: SearchMock;
  // The location-tree advisory lock, taken on the transaction client.
  let executeRaw: jest.Mock;
  let queryRaw: jest.Mock;
  // Live location ids, as seedTree leaves them: what the delete's own-row lock (#1604) finds.
  let liveLocationIds: Set<string>;
  // The live children the delete locks FOR NO KEY UPDATE (#1604 review), as seedDependents leaves them.
  let childIds: string[];
  // The own-row and children locks answer from the seeded rows; any other raw query falls through.
  const lockedLocationRows = (
    strings: TemplateStringsArray,
    values: unknown[],
  ): { id: string }[] | undefined => {
    const sql = strings.join('?');
    if (!sql.includes('FROM "locations"')) return undefined;
    if (sql.includes('"parentId" =')) return childIds.map((id) => ({ id }));
    return liveLocationIds.has(values[0] as string)
      ? [{ id: values[0] as string }]
      : [];
  };
  let asset: { count: jest.Mock; findMany: jest.Mock; updateMany: jest.Mock };
  let purchaseOrder: { updateMany: jest.Mock };
  let purchaseOrderEvent: { createMany: jest.Mock };
  let history: { record: jest.Mock; recordMany: jest.Mock };
  let readable: Set<string>;
  let prismaTransaction: () => jest.Mock;
  // Every write records whether it ran inside the $transaction callback.
  let inTransaction: boolean;
  let writesOutsideTx: string[];

  beforeEach(async () => {
    inTransaction = false;
    writesOutsideTx = [];
    const write = (name: string, impl?: (...args: never[]) => unknown) =>
      jest.fn((...args: never[]) => {
        if (!inTransaction) writesOutsideTx.push(name);
        return impl ? impl(...args) : Promise.resolve(undefined);
      });
    location = {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: write('location.updateMany'),
      count: jest.fn(),
    };
    asset = {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: write('asset.updateMany'),
    };
    purchaseOrder = { updateMany: write('purchaseOrder.updateMany') };
    purchaseOrderEvent = {
      createMany: write('purchaseOrderEvent.createMany'),
    };
    history = {
      record: write('history.record'),
      recordMany: write('history.recordMany'),
    };
    readable = new Set(['asset:read', 'location:read', 'purchaseOrder:read']);
    search = { upsert: jest.fn(), remove: jest.fn(), search: jest.fn() };

    executeRaw = jest.fn().mockResolvedValue(0);
    liveLocationIds = new Set();
    childIds = [];
    queryRaw = jest.fn((strings: TemplateStringsArray, ...values: unknown[]) =>
      Promise.resolve(lockedLocationRows(strings, values) ?? []),
    );
    const prisma: Record<string, unknown> = {
      location,
      asset,
      purchaseOrder,
      purchaseOrderEvent,
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
    };
    prismaTransaction = () => prisma.$transaction as jest.Mock;
    prisma.$transaction = jest.fn(
      async (arg: Promise<unknown>[] | ((tx: unknown) => Promise<unknown>)) => {
        if (typeof arg !== 'function') return Promise.all(arg);
        inTransaction = true;
        try {
          return await arg(prisma);
        } finally {
          inTransaction = false;
        }
      },
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        LocationsService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: search },
        ActorService,
        { provide: AssetHistoryService, useValue: history },
        {
          provide: PermissionResolverService,
          useValue: {
            principalHas: jest.fn((_p: unknown, perm: string) =>
              Promise.resolve(readable.has(perm)),
            ),
          },
        },
      ],
    }).compile();

    service = moduleRef.get(LocationsService);
  });

  it('creates a location with only the required fields (name + type)', async () => {
    const dto = { name: 'HQ', type: 'OFFICE' as const };
    const created = {
      id: 'clh000000000000000000000',
      ...dto,
      description: null,
      address: null,
      floor: null,
      notes: null,
      deletedAt: null,
    };
    location.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(location.create).toHaveBeenCalledWith({ data: dto });
    // Fire-and-forget search sync (ADR-0035): the created location is upserted into `locations`.
    expect(search.upsert).toHaveBeenCalledWith('locations', {
      id: 'clh000000000000000000000',
      name: 'HQ',
      type: 'OFFICE',
      address: null,
      floor: null,
    });
  });

  it('creates a location with the optional fields populated', async () => {
    const dto = {
      name: 'Datacenter A',
      type: 'DATACENTER' as const,
      description: 'Primary datacenter',
      address: '123 Main St',
      floor: 'Subsuelo 1',
      notes: 'Restricted access',
    };
    const created = { id: 'clh000000000000000000001', ...dto, deletedAt: null };
    location.create.mockResolvedValue(created);

    await expect(service.create(dto)).resolves.toEqual(created);
    expect(location.create).toHaveBeenCalledWith({ data: dto });
  });

  it('returns a location by id when it exists', async () => {
    const found = {
      id: 'clh000000000000000000000',
      name: 'HQ',
      deletedAt: null,
    };
    location.findFirst.mockResolvedValue(found);

    await expect(service.findOne('clh000000000000000000000')).resolves.toEqual(
      found,
    );
    expect(location.findFirst).toHaveBeenCalledWith({
      where: { id: 'clh000000000000000000000' },
    });
  });

  it('throws NotFound when the location does not exist', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('applies a partial update after confirming the location exists', async () => {
    location.findFirst.mockResolvedValue({ id: 'clh1', deletedAt: null });
    location.update.mockResolvedValue({ id: 'clh1', name: 'HQ renamed' });

    await service.update('clh1', { name: 'HQ renamed' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'clh1' },
      data: { name: 'HQ renamed' },
    });
    // Re-index the updated location (ADR-0035).
    expect(search.upsert).toHaveBeenCalledWith('locations', {
      id: 'clh1',
      name: 'HQ renamed',
      type: undefined,
      address: undefined,
      floor: undefined,
    });
  });

  it('does not update a location that is missing', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(
      service.update('missing', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(location.update).not.toHaveBeenCalled();
  });

  it('soft-deletes by setting deletedAt (never hard delete)', async () => {
    liveLocationIds.add('clh1');
    location.update.mockResolvedValue({ id: 'clh1', deletedAt: new Date() });

    await service.remove('clh1');

    // Soft delete = an UPDATE that stamps deletedAt, never a hard delete().
    expect(location.update).toHaveBeenCalledTimes(1);
    const calls = location.update.mock.calls as Array<
      [{ where: { id: string }; data: { deletedAt: Date } }]
    >;
    expect(calls[0][0].where).toEqual({ id: 'clh1' });
    expect(calls[0][0].data.deletedAt).toBeInstanceOf(Date);
    // Soft-delete drops the location from the search index (ADR-0035).
    expect(search.remove).toHaveBeenCalledWith('locations', 'clh1');
  });

  it('does not soft-delete a location that is missing', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.remove('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(location.update).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('findPage defaults to createdAt desc and returns the Page envelope', async () => {
    location.findMany.mockResolvedValue([{ id: 'loc1' }]);
    location.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );

    expect(location.findMany).toHaveBeenCalledWith({
      // The default `active` slice scopes the list to live rows (ADR-0041).
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      skip: 0,
    });
    expect(page).toEqual({
      items: [{ id: 'loc1' }],
      total: 1,
      limit: 50,
      offset: 0,
    });
  });

  it('findPage applies a case-insensitive q over name/address/floor/description', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      { q: 'hq' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      location.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({
      OR: [
        { name: { contains: 'hq', mode: 'insensitive' } },
        { address: { contains: 'hq', mode: 'insensitive' } },
        { floor: { contains: 'hq', mode: 'insensitive' } },
        { description: { contains: 'hq', mode: 'insensitive' } },
      ],
      deletedAt: null,
    });
  });

  it('findPage filters by type when set', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      { type: 'DATACENTER' },
      { limit: 50, offset: 0, deleted: 'active' },
    );

    const call = (
      location.findMany.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >
    )[0][0];
    expect(call.where).toEqual({ type: 'DATACENTER', deletedAt: null });
    // The count query must filter on the SAME where so total matches the page.
    const countCall = (
      location.count.mock.calls as Array<[{ where: Record<string, unknown> }]>
    )[0][0];
    expect(countCall.where).toEqual({ type: 'DATACENTER', deletedAt: null });
  });

  it('findPage honors an allowlisted sort and rejects an unknown one (400)', async () => {
    location.findMany.mockResolvedValue([]);
    location.count.mockResolvedValue(0);

    await service.findPage(
      {},
      { limit: 50, offset: 0, sort: 'name', dir: 'asc', deleted: 'active' },
    );
    const call = (
      location.findMany.mock.calls as Array<[{ orderBy: unknown }]>
    )[0][0];
    expect(call.orderBy).toEqual([{ name: 'asc' }, { id: 'desc' }]);

    await expect(
      service.findPage(
        {},
        { limit: 50, offset: 0, sort: 'nope', dir: 'asc', deleted: 'active' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('findPage deleted=only returns soft-deleted rows via the includeSoftDeleted escape hatch (ADR-0041)', async () => {
    location.findMany.mockResolvedValue([{ id: 'gone' }]);
    location.count.mockResolvedValue(1);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'only' },
    );

    // The archived slice scopes to soft-deleted rows AND passes the ADR-0032 escape hatch so the
    // read filter doesn't re-hide them.
    expect(location.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
      skip: 0,
      includeSoftDeleted: true,
    });
    expect(location.count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
    expect(page.items).toEqual([{ id: 'gone' }]);
  });

  // --- restore (ADR-0041) --------------------------------------------------
  it('restore clears deletedAt for a soft-deleted location and re-indexes it', async () => {
    location.findFirst.mockResolvedValue({ id: 'loc1', deletedAt: new Date() });
    location.update.mockResolvedValue({ id: 'loc1', deletedAt: null });

    const restored = await service.restore('loc1');

    // Found via the includeSoftDeleted escape hatch (the read filter would hide it).
    expect(location.findFirst).toHaveBeenCalledWith({
      where: { id: 'loc1' },
      includeSoftDeleted: true,
    });
    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'loc1' },
      data: { deletedAt: null },
    });
    expect(restored.deletedAt).toBeNull();
    expect(search.upsert).toHaveBeenCalledWith('locations', expect.anything());
  });

  it('restore is idempotent (no update) when the location is already live', async () => {
    location.findFirst.mockResolvedValue({ id: 'loc1', deletedAt: null });

    await service.restore('loc1');

    expect(location.update).not.toHaveBeenCalled();
  });

  it('restore 404s when the location never existed', async () => {
    location.findFirst.mockResolvedValue(null);

    await expect(service.restore('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // --- hierarchy / cycle prevention (#845) ---------------------------------

  // Drive findFirst off an in-memory tree so both findOne (existence) and the parent-walk resolve
  // against the same rows; unknown ids (or soft-deleted rows omitted from the map) return null.
  type Node = {
    id: string;
    name?: string;
    type?: string;
    parentId: string | null;
    /** Archived: hidden from reads unless the call carries the includeSoftDeleted escape hatch. */
    deleted?: boolean;
  };
  const seedTree = (nodes: Node[]) => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    liveLocationIds = new Set(nodes.filter((n) => !n.deleted).map((n) => n.id));
    location.findFirst.mockImplementation(
      ({
        where,
        includeSoftDeleted,
      }: {
        where: { id: string };
        includeSoftDeleted?: boolean;
      }) => {
        const node = byId.get(where.id);
        if (!node || (node.deleted && !includeSoftDeleted)) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          ...node,
          deletedAt: node.deleted ? new Date() : null,
        });
      },
    );
  };

  it('create sets a valid parent and rejects a missing/soft-deleted parent (400)', async () => {
    seedTree([{ id: 'root', parentId: null }]);
    location.create.mockResolvedValue({ id: 'child', parentId: 'root' });

    await expect(
      service.create({ name: 'Rack 1', type: 'RACK', parentId: 'root' }),
    ).resolves.toEqual({ id: 'child', parentId: 'root' });
    expect(location.create).toHaveBeenCalledWith({
      data: { name: 'Rack 1', type: 'RACK', parentId: 'root' },
    });

    // A parentId with no live row (never existed, or soft-deleted → filtered out) is rejected.
    location.create.mockClear();
    await expect(
      service.create({ name: 'Rack 2', type: 'RACK', parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(location.create).not.toHaveBeenCalled();
  });

  it('update rejects a location as its own parent (400)', async () => {
    seedTree([{ id: 'A', parentId: null }]);

    await expect(service.update('A', { parentId: 'A' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('update rejects re-parenting under a descendant — cycle (400)', async () => {
    // A → B → C. Moving A under C would close a loop (C is a descendant of A).
    seedTree([
      { id: 'A', parentId: null },
      { id: 'B', parentId: 'A' },
      { id: 'C', parentId: 'B' },
    ]);

    await expect(service.update('A', { parentId: 'C' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('update accepts a valid (non-cyclic) parent', async () => {
    seedTree([
      { id: 'root', parentId: null },
      { id: 'child', parentId: null },
    ]);
    location.update.mockResolvedValue({ id: 'child', parentId: 'root' });

    await service.update('child', { parentId: 'root' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'child' },
      data: { parentId: 'root' },
    });
  });

  it('update rejects a missing/soft-deleted parent (400)', async () => {
    seedTree([{ id: 'child', parentId: null }]);

    await expect(
      service.update('child', { parentId: 'ghost' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(location.update).not.toHaveBeenCalled();
  });

  // AUD-080: a live node under an archived ancestor is a valid parent; only the parent must be live.
  it('update accepts a live parent whose ancestor is archived', async () => {
    seedTree([
      { id: 'hq', parentId: null, deleted: true },
      { id: 'room5', parentId: 'hq' },
      { id: 'rack', parentId: null },
    ]);
    location.update.mockResolvedValue({ id: 'rack', parentId: 'room5' });

    await service.update('rack', { parentId: 'room5' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'rack' },
      data: { parentId: 'room5' },
    });
  });

  it('create accepts a live parent whose ancestor is archived', async () => {
    seedTree([
      { id: 'hq', parentId: null, deleted: true },
      { id: 'room5', parentId: 'hq' },
    ]);
    location.create.mockResolvedValue({ id: 'rack', parentId: 'room5' });

    await service.create({ name: 'Rack', type: 'RACK', parentId: 'room5' });

    expect(location.create).toHaveBeenCalledTimes(1);
  });

  it('update still refuses a cycle that runs through an archived ancestor (400)', async () => {
    // building → floor (archived) → room. Moving building under room would close a loop once the floor
    // is restored, so the walk must see through the archived floor.
    seedTree([
      { id: 'building', parentId: null },
      { id: 'floor', parentId: 'building', deleted: true },
      { id: 'room', parentId: 'floor' },
    ]);

    await expect(
      service.update('building', { parentId: 'room' }),
    ).rejects.toThrow(
      'A location cannot be moved under one of its own descendants.',
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('restore refuses (409) a location whose parent is still archived', async () => {
    seedTree([
      { id: 'hq', parentId: null, deleted: true },
      { id: 'room5', parentId: 'hq', deleted: true },
    ]);

    await expect(service.restore('room5')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(location.update).not.toHaveBeenCalled();
  });

  it('restore brings back a location whose parent is live', async () => {
    seedTree([
      { id: 'hq', parentId: null },
      { id: 'room5', parentId: 'hq', deleted: true },
    ]);
    location.update.mockResolvedValue({ id: 'room5', parentId: 'hq' });

    await service.restore('room5');

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'room5' },
      data: { deletedAt: null },
    });
  });

  // --- tree lock: every tree-shape write checks and writes under one advisory lock ---

  const expectLockedBefore = (firstRead: jest.Mock) => {
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0]).toContain('lazyit.location_tree');
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      firstRead.mock.invocationCallOrder[0],
    );
  };

  it('a move takes the tree lock before its cycle check, so two opposing moves serialize', async () => {
    seedTree([
      { id: 'A', parentId: null },
      { id: 'B', parentId: null },
    ]);
    location.update.mockResolvedValue({ id: 'A', parentId: 'B' });

    await service.update('A', { parentId: 'B' });

    expectLockedBefore(location.findFirst);
  });

  it('promoting to root takes the tree lock too', async () => {
    seedTree([{ id: 'A', parentId: 'B' }]);
    location.update.mockResolvedValue({ id: 'A', parentId: null });

    await service.update('A', { parentId: null });

    expectLockedBefore(location.findFirst);
  });

  it('a nested create checks its parent under the tree lock', async () => {
    seedTree([{ id: 'root', parentId: null }]);
    location.create.mockResolvedValue({ id: 'child', parentId: 'root' });

    await service.create({ name: 'Rack', type: 'RACK', parentId: 'root' });

    expectLockedBefore(location.findFirst);
  });

  it('a field-only update and a root create do not take the tree lock', async () => {
    seedTree([{ id: 'A', parentId: null }]);
    location.update.mockResolvedValue({ id: 'A', name: 'renamed' });
    location.create.mockResolvedValue({ id: 'B', parentId: null });

    await service.update('A', { name: 'renamed' });
    await service.create({ name: 'Site', type: 'OFFICE' });

    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('delete and restore run under the tree lock', async () => {
    seedTree([
      { id: 'hq', parentId: null },
      { id: 'room', parentId: 'hq', deleted: true },
    ]);
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq');
    expectLockedBefore(queryRaw);

    executeRaw.mockClear();
    location.findFirst.mockClear();
    location.update.mockResolvedValue({ id: 'room', deletedAt: null });
    await service.restore('room');
    expectLockedBefore(location.findFirst);
  });

  it('the cycle walk ends on a corrupt loop above the parent instead of spinning', async () => {
    // loopA ↔ loopB is already corrupt; moving X under loopA does not put X in that loop.
    seedTree([
      { id: 'loopA', parentId: 'loopB' },
      { id: 'loopB', parentId: 'loopA' },
      { id: 'X', parentId: null },
    ]);
    location.update.mockResolvedValue({ id: 'X', parentId: 'loopA' });

    await service.update('X', { parentId: 'loopA' });

    expect(location.update).toHaveBeenCalledWith({
      where: { id: 'X' },
      data: { parentId: 'loopA' },
    });
  });

  it('findOneWithAncestors resolves the path ordered root→self inclusive', async () => {
    seedTree([
      { id: 'site', name: 'HQ', type: 'OFFICE', parentId: null },
      { id: 'room', name: 'Server Room', type: 'DATACENTER', parentId: 'site' },
      { id: 'rack', name: 'Rack 1', type: 'RACK', parentId: 'room' },
    ]);

    const detail = await service.findOneWithAncestors('rack');

    expect(detail.id).toBe('rack');
    expect(detail.path).toEqual([
      { id: 'site', name: 'HQ', type: 'OFFICE' },
      { id: 'room', name: 'Server Room', type: 'DATACENTER' },
      { id: 'rack', name: 'Rack 1', type: 'RACK' },
    ]);
  });

  it('findOneWithAncestors returns a single-element path for a root location', async () => {
    seedTree([{ id: 'site', name: 'HQ', type: 'OFFICE', parentId: null }]);

    const detail = await service.findOneWithAncestors('site');

    expect(detail.path).toEqual([{ id: 'site', name: 'HQ', type: 'OFFICE' }]);
  });

  // --- delete with one resolution (AUD-024 / SEC-041) ------------------------

  const ADMIN = {
    kind: 'human' as const,
    user: { id: 'admin-1', role: 'ADMIN' },
  } as never;

  // What still points at `hq`: two live assets and an open purchase (SQL, so served by $queryRaw).
  const seedDependents = (opts: {
    assets?: string[];
    purchases?: string[];
    children?: string[];
  }) => {
    childIds = opts.children ?? [];
    queryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join('?');
        const locked = lockedLocationRows(strings, values);
        if (locked) return Promise.resolve(locked);
        if (sql.includes('FROM "assets"')) {
          return Promise.resolve((opts.assets ?? []).map((id) => ({ id })));
        }
        if (sql.includes('FROM "purchase_orders"')) {
          return Promise.resolve(
            (opts.purchases ?? []).map((id, i) => ({
              id,
              reference: `PO-${id}`,
              createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
            })),
          );
        }
        return Promise.resolve([]);
      },
    );
    location.findMany.mockImplementation(
      ({ where }: { where: { parentId?: string } }) =>
        Promise.resolve(
          where.parentId === 'hq'
            ? (opts.children ?? []).map((id) => ({ id }))
            : [],
        ),
    );
  };

  const softDeleted = () =>
    (location.update.mock.calls as Array<[{ data: Row }]>).some(
      ([args]) => args.data.deletedAt instanceof Date,
    );
  type Row = Record<string, unknown>;

  it('refuses (409) to delete a location still in use when no strategy is given, with the counts', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({
      assets: ['a1', 'a2'],
      children: ['room'],
      purchases: ['po1'],
    });

    const err = await service.remove('hq').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'DELETE_RESOLUTION_REQUIRED',
      dependents: { assets: 2, childLocations: 1, purchaseOrders: 1 },
    });
    expect(softDeleted()).toBe(false);
    expect(asset.updateMany).not.toHaveBeenCalled();
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('an unused location deletes without a strategy', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({});
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq');

    expect(softDeleted()).toBe(true);
    expect(asset.updateMany).not.toHaveBeenCalled();
  });

  it("detach clears the assets' location (with history), makes children top-level and clears open purchases", async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({
      assets: ['a1', 'a2'],
      children: ['room'],
      purchases: ['po1'],
    });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'detach' }, ADMIN);

    expect(asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { locationId: null },
    });
    // One batched insert for every moved asset, never one round-trip per asset.
    expect(history.record).not.toHaveBeenCalled();
    expect(history.recordMany).toHaveBeenCalledTimes(1);
    expect(history.recordMany).toHaveBeenCalledWith(expect.anything(), [
      {
        assetId: 'a1',
        eventType: 'LOCATION_CHANGED',
        payload: { from: 'hq', to: null },
        actor: { userId: 'admin-1' },
      },
      {
        assetId: 'a2',
        eventType: 'LOCATION_CHANGED',
        payload: { from: 'hq', to: null },
        actor: { userId: 'admin-1' },
      },
    ]);
    expect(location.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['room'] } },
      data: { parentId: null },
    });
    expect(purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['po1'] } },
      data: { deliveryLocationId: null },
    });
    expect(purchaseOrderEvent.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          purchaseOrderId: 'po1',
          eventType: 'UPDATED',
          payload: {
            fields: ['deliveryLocationId'],
            changes: { deliveryLocationId: { from: 'hq', to: null } },
          },
          performedById: 'admin-1',
        }),
      ],
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toEqual([]);
  });

  it('move re-points the assets and open purchases and re-parents the children under the target', async () => {
    seedTree([
      { id: 'hq', parentId: null },
      { id: 'warehouse', parentId: null },
    ]);
    seedDependents({ assets: ['a1'], children: ['room'], purchases: ['po1'] });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove(
      'hq',
      { strategy: 'move', targetId: 'warehouse' },
      ADMIN,
    );

    expect(asset.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1'] } },
      data: { locationId: 'warehouse' },
    });
    expect(history.recordMany).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ payload: { from: 'hq', to: 'warehouse' } }),
    ]);
    expect(location.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['room'] } },
      data: { parentId: 'warehouse' },
    });
    expect(purchaseOrder.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['po1'] } },
      data: { deliveryLocationId: 'warehouse' },
    });
    expect(softDeleted()).toBe(true);
    expect(writesOutsideTx).toEqual([]);
  });

  it.each([
    ['itself', 'hq'],
    ['one of its descendants', 'rack'],
    ['an archived location', 'old'],
    ['a missing location', 'ghost'],
  ])(
    'refuses (400) to move everything to %s, and writes nothing',
    async (_what, targetId) => {
      seedTree([
        { id: 'hq', parentId: null },
        { id: 'room', parentId: 'hq' },
        { id: 'rack', parentId: 'room' },
        { id: 'old', parentId: null, deleted: true },
      ]);
      seedDependents({ assets: ['a1'], children: ['room'] });

      await expect(
        service.remove('hq', { strategy: 'move', targetId }, ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(asset.updateMany).not.toHaveBeenCalled();
      expect(location.updateMany).not.toHaveBeenCalled();
      expect(history.record).not.toHaveBeenCalled();
      expect(softDeleted()).toBe(false);
    },
  );

  it('a failure mid-way rejects the whole delete: every write ran inside the one transaction and nothing is soft-deleted or unindexed', async () => {
    seedTree([
      { id: 'hq', parentId: null },
      { id: 'warehouse', parentId: null },
    ]);
    seedDependents({ assets: ['a1', 'a2'], children: ['room'] });
    history.recordMany.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.remove('hq', { strategy: 'move', targetId: 'warehouse' }, ADMIN),
    ).rejects.toThrow('connection lost');

    expect(writesOutsideTx).toEqual([]);
    expect(location.updateMany).not.toHaveBeenCalled();
    expect(softDeleted()).toBe(false);
    expect(search.remove).not.toHaveBeenCalled();
  });

  it('a move and a delete serialize on the tree lock taken before anything is read', async () => {
    seedTree([
      { id: 'hq', parentId: null },
      { id: 'warehouse', parentId: null },
    ]);
    seedDependents({ assets: ['a1'] });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'move', targetId: 'warehouse' });

    expectLockedBefore(queryRaw);
  });

  it('the delete-impact preview counts everything and lists only what the caller may read', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({ purchases: ['po1', 'po2'] });
    asset.count.mockResolvedValue(3);
    asset.findMany.mockResolvedValue([
      { id: 'a1', name: 'Laptop', assetTag: 'LT-1' },
    ]);
    location.count.mockResolvedValue(1);
    location.findMany.mockResolvedValue([
      { id: 'room', name: 'Room', type: 'OTHER' },
    ]);
    readable.delete('purchaseOrder:read');

    const impact = await service.deleteImpact('hq', ADMIN);

    expect(impact).toEqual({
      assets: {
        total: 3,
        items: [{ id: 'a1', name: 'Laptop', assetTag: 'LT-1' }],
      },
      childLocations: {
        total: 1,
        items: [{ id: 'room', name: 'Room', type: 'OTHER' }],
      },
      purchaseOrders: { total: 2, items: null },
    });
    expect(asset.count).toHaveBeenCalledWith({
      where: { locationId: 'hq', deletedAt: null },
    });
    expect(asset.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });

  it('the delete-impact preview 404s for an archived location', async () => {
    seedTree([{ id: 'old', parentId: null, deleted: true }]);

    await expect(service.deleteImpact('old', ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('gives the delete transaction more than the 5 s default, so a large location can still be deleted', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({ assets: Array.from({ length: 3000 }, (_, i) => `a${i}`) });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'detach' }, ADMIN);

    expect(asset.updateMany).toHaveBeenCalledTimes(1);
    expect(history.recordMany).toHaveBeenCalledTimes(1);
    expect(
      (history.recordMany.mock.calls[0] as [unknown, unknown[]])[1],
    ).toHaveLength(3000);
    const txCalls = (prismaTransaction().mock.calls as unknown[][]).filter(
      (c) => typeof c[0] === 'function',
    );
    expect(txCalls[0][1]).toEqual({ timeout: 30_000 });
  });

  it('locks the open purchases it re-points (FOR UPDATE OF po) and only those in an open status', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({ purchases: ['po1'] });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'detach' }, ADMIN);
    await service.deleteImpact('hq', ADMIN);

    const purchaseQueries = (
      queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]
    ).filter(([strings]) =>
      strings.join('?').includes('FROM "purchase_orders"'),
    );
    const lockOf = (values: unknown[]) =>
      values.some(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          'strings' in v &&
          (v as { strings: string[] }).strings
            .join('')
            .includes('FOR UPDATE OF po'),
      );
    expect(purchaseQueries).toHaveLength(2);
    // The delete locks them; the read-only preview does not.
    expect(lockOf(purchaseQueries[0].slice(1))).toBe(true);
    expect(lockOf(purchaseQueries[1].slice(1))).toBe(false);
    expect(purchaseQueries[0].slice(1)).toContainEqual(['DRAFT', 'ORDERED']);
  });

  it('locks the open purchases in id order, as the model delete and supplier merge do, and still lists them oldest first', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({});
    queryRaw.mockImplementation(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        Promise.resolve(
          lockedLocationRows(strings, values) ??
            (strings.join('?').includes('FROM "purchase_orders"')
              ? [
                  {
                    id: 'po-a',
                    reference: 'PO-A',
                    createdAt: new Date('2026-10-02'),
                  },
                  {
                    id: 'po-b',
                    reference: 'PO-B',
                    createdAt: new Date('2026-10-01'),
                  },
                ]
              : []),
        ),
    );
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'detach' }, ADMIN);
    const impact = await service.deleteImpact('hq', ADMIN);

    const [lock] = (
      queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][]
    )
      .map(([strings]) => strings.join('?'))
      .filter((sql) => sql.includes('FROM "purchase_orders"'));
    expect(lock).toMatch(/ORDER BY po\."id" ASC/);
    expect(lock).not.toMatch(/ORDER BY po\."createdAt"/);
    expect(impact.purchaseOrders.items).toEqual([
      { id: 'po-b', reference: 'PO-B' },
      { id: 'po-a', reference: 'PO-A' },
    ]);
  });

  // --- concurrent writers (#1604) -------------------------------------------

  it('locks in one order: tree, own row, child locations, open purchases, then assets (#1604, #1696)', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({ assets: ['a1'], children: ['room'], purchases: ['po1'] });
    location.update.mockResolvedValue({ id: 'hq', deletedAt: new Date() });

    await service.remove('hq', { strategy: 'detach' }, ADMIN);

    const calls = queryRaw.mock.calls as [TemplateStringsArray, ...unknown[]][];
    const sqls = calls.map(([strings]) => strings.join('?'));
    const lockOf = (values: unknown[]) =>
      values
        .filter(
          (v): v is { strings: string[] } =>
            typeof v === 'object' && v !== null && 'strings' in v,
        )
        .map((v) => v.strings.join(''))
        .join('');
    const own = sqls.findIndex(
      (q) => q.includes('FROM "locations"') && q.includes('"id" = ?'),
    );
    const children = sqls.findIndex((q) => q.includes('"parentId" = ?'));
    const purchases = sqls.findIndex((q) =>
      q.includes('FROM "purchase_orders"'),
    );
    const assets = sqls.findIndex((q) => q.includes('FROM "assets"'));
    expect(own).toBe(0);
    expect(sqls[own]).toMatch(/"deletedAt" IS NULL[\s\S]*FOR UPDATE/);
    expect(calls[own][1]).toBe('hq');
    // Live children only, in id order, NO KEY UPDATE (they are re-parented, never re-keyed).
    expect(sqls[children]).toMatch(
      /"deletedAt" IS NULL[\s\S]*ORDER BY "id" FOR NO KEY UPDATE/,
    );
    expect(lockOf(calls[purchases].slice(1))).toContain('FOR UPDATE OF po');
    expect(sqls[assets]).toMatch(/ORDER BY "id" FOR UPDATE/);
    expect(own).toBeLessThan(children);
    expect(children).toBeLessThan(purchases);
    expect(purchases).toBeLessThan(assets);
    // The tree lock comes first of all.
    expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      queryRaw.mock.invocationCallOrder[0],
    );
    // The locked children are the ones re-parented.
    expect(location.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['room'] } },
      data: { parentId: null },
    });
  });

  it('a location archived by a delete that committed while this one waited on the row lock is a 404, and nothing is written', async () => {
    seedTree([{ id: 'hq', parentId: null }]);
    seedDependents({ assets: ['a1'] });
    // The row lock re-reads the committed row: the other delete archived it.
    liveLocationIds.delete('hq');

    await expect(
      service.remove('hq', { strategy: 'detach' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);

    const sqls = (queryRaw.mock.calls as [TemplateStringsArray][]).map(
      ([strings]) => strings.join('?'),
    );
    expect(sqls.some((sql) => sql.includes('FROM "assets"'))).toBe(false);
    expect(asset.updateMany).not.toHaveBeenCalled();
    expect(softDeleted()).toBe(false);
  });
});
