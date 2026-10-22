import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  CONTAINER_ID_SEPARATOR,
  GUEST_ID_SEPARATOR,
  SOFTWARE_WATCH_LIMIT,
} from '@lazyit/shared';
import {
  SOFTWARE_WATCH_POPULATION_WHERE,
  SoftwareWatchService,
} from './software-watch.service';
import { PrismaService } from '../prisma/prisma.service';
import { AgentPolicyService } from './agent-policy.service';

// The generated client is stubbed down to the two symbols the service uses at call time.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
    join: (values: unknown[]) => ({ joined: values }),
  },
}));

type Mock = jest.Mock;

const WATCH_ID = 'clwatch00000000000000000a';
const PAGE = { limit: 50, offset: 0, deleted: 'active' } as const;
const HUMAN = {
  kind: 'human',
  user: { id: '9f0d1c2b-3a4e-4f5a-8b6c-7d8e9f0a1b2c' },
} as never;

/** A watch row as the select returns it. */
function watch(over: Record<string, unknown> = {}) {
  return {
    id: WATCH_ID,
    name: 'openssl',
    createdAt: new Date('2026-10-21T10:00:00.000Z'),
    createdById: null,
    createdBy: null,
    ...over,
  };
}

/** A population node as the scalar `findMany` returns it. */
function node(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    label: id,
    kind: 'PHYSICAL_HOST',
    status: 'ONLINE',
    state: 'CONFIRMED',
    lastReportedAt: new Date('2026-10-21T09:00:00.000Z'),
    agentPolicy: null,
    ...over,
  };
}

describe('SoftwareWatchService (#1684)', () => {
  let service: SoftwareWatchService;
  let watchFindMany: Mock;
  let watchFindFirst: Mock;
  let watchCount: Mock;
  let watchCreate: Mock;
  let watchUpdate: Mock;
  let nodeFindMany: Mock;
  let queryRaw: Mock;
  let getSettings: Mock;

  /**
   * Wire the fleet: `nodes` is the population, `evidence` the per-node projection and `packages` the
   * matched entries the second projection returns. The two raw queries are told apart by order: the
   * evidence projection always runs first.
   */
  function fleet(
    nodes: ReturnType<typeof node>[],
    evidence: Array<{
      id: string;
      hasSoftware: boolean | null;
      collectedAt?: string | null;
    }>,
    packages: Array<{
      nodeId: string;
      name: string | null;
      version: string | null;
    }> = [],
  ) {
    nodeFindMany.mockResolvedValue(nodes);
    queryRaw
      .mockResolvedValueOnce(evidence.map((e) => ({ collectedAt: null, ...e })))
      .mockResolvedValueOnce(packages);
  }

  beforeEach(async () => {
    watchFindMany = jest.fn().mockResolvedValue([watch()]);
    watchFindFirst = jest.fn().mockResolvedValue(watch());
    watchCount = jest.fn().mockResolvedValue(0);
    watchCreate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(watch({ ...data })),
    );
    watchUpdate = jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(watch({ ...data })),
    );
    nodeFindMany = jest.fn().mockResolvedValue([]);
    queryRaw = jest.fn().mockResolvedValue([]);
    getSettings = jest.fn().mockResolvedValue({
      revision: 1,
      settings: {},
      effective: {},
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SoftwareWatchService,
        {
          provide: PrismaService,
          useValue: {
            softwareWatch: {
              findMany: watchFindMany,
              findFirst: watchFindFirst,
              count: watchCount,
              create: watchCreate,
              update: watchUpdate,
            },
            infraNode: { findMany: nodeFindMany },
            $queryRaw: queryRaw,
          },
        },
        { provide: AgentPolicyService, useValue: { getSettings } },
      ],
    }).compile();
    service = moduleRef.get(SoftwareWatchService);
  });

  // ── population ────────────────────────────────────────────────────────────

  it('answers over live agent-reported HOSTS only — manual nodes and container/guest children are out', async () => {
    fleet([], []);
    await service.get(WATCH_ID);
    expect(SOFTWARE_WATCH_POPULATION_WHERE).toEqual({
      source: 'AGENT',
      OR: [
        { externalId: null },
        {
          NOT: {
            OR: [
              { externalId: { contains: CONTAINER_ID_SEPARATOR } },
              { externalId: { contains: GUEST_ID_SEPARATOR } },
            ],
          },
        },
      ],
    });
    expect(nodeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: SOFTWARE_WATCH_POPULATION_WHERE }),
    );
    // `specs` is never selected — the evidence comes from the narrow projections.
    const args = (nodeFindMany.mock.calls as unknown[][])[0][0] as {
      select: object;
    };
    const select = args.select;
    expect(select).not.toHaveProperty('specs');
  });

  it('an empty fleet runs no raw query and yields an all-zero distribution', async () => {
    fleet([], []);
    const summary = await service.get(WATCH_ID);
    expect(queryRaw).not.toHaveBeenCalled();
    expect(summary.distribution).toEqual({
      hostsTotal: 0,
      installed: 0,
      missing: 0,
      unknown: 0,
      versions: [],
    });
  });

  // ── missing vs unknown ────────────────────────────────────────────────────

  it('INSTALLED / MISSING / UNKNOWN: a host with NO stored list is unknown, never missing', async () => {
    fleet(
      [node('a'), node('b'), node('c'), node('d')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true }, // collected, package absent → MISSING
        { id: 'c', hasSoftware: false }, // software key not an array → UNKNOWN
        { id: 'd', hasSoftware: null }, // no specs / no software key (policy disabled) → UNKNOWN
      ],
      [{ nodeId: 'a', name: 'OpenSSL', version: '3.0.13' }],
    );
    const { distribution } = await service.get(WATCH_ID);
    expect(distribution).toEqual({
      hostsTotal: 4,
      installed: 1,
      missing: 1,
      unknown: 2,
      versions: [{ version: '3.0.13', hosts: 1 }],
    });

    queryRaw.mockReset();
    fleet(
      [node('a'), node('b'), node('c'), node('d')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
        { id: 'c', hasSoftware: false },
        { id: 'd', hasSoftware: null },
      ],
      [{ nodeId: 'a', name: 'OpenSSL', version: '3.0.13' }],
    );
    const page = await service.listHosts(WATCH_ID, {}, PAGE);
    expect(page.items.map((h) => [h.id, h.presence, h.unknownReason])).toEqual([
      ['a', 'INSTALLED', null],
      ['b', 'MISSING', null],
      ['c', 'UNKNOWN', 'NOT_COLLECTED'],
      ['d', 'UNKNOWN', 'NOT_COLLECTED'],
    ]);
  });

  it('a host whose list lacks the package but whose policy excludes it by glob is UNKNOWN, not MISSING', async () => {
    getSettings.mockResolvedValue({
      revision: 3,
      settings: { exclude: { softwareNames: ['openssl*'] } },
      effective: {},
    });
    fleet(
      [
        node('a'),
        // The node override REPLACES the instance list wholesale (#1140): this one excludes nothing.
        node('b', { agentPolicy: { exclude: { softwareNames: [] } } }),
        // An unreadable override contributes nothing (read-tolerant), so the instance glob applies.
        node('c', { agentPolicy: { collect: 'not-an-object' } }),
      ],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
        { id: 'c', hasSoftware: true },
      ],
    );
    const page = await service.listHosts(WATCH_ID, {}, PAGE);
    expect(page.items.map((h) => [h.id, h.presence, h.unknownReason])).toEqual([
      ['a', 'UNKNOWN', 'EXCLUDED_BY_POLICY'],
      ['b', 'MISSING', null],
      ['c', 'UNKNOWN', 'EXCLUDED_BY_POLICY'],
    ]);
  });

  it('a stored list that NAMES the package wins over an exclusion added since (evidence first)', async () => {
    getSettings.mockResolvedValue({
      revision: 3,
      settings: { exclude: { softwareNames: ['openssl'] } },
      effective: {},
    });
    fleet(
      [node('a')],
      [{ id: 'a', hasSoftware: true }],
      [{ nodeId: 'a', name: 'openssl', version: '3.0.13' }],
    );
    const { distribution } = await service.get(WATCH_ID);
    expect(distribution.installed).toBe(1);
  });

  // ── normalization on the read side ────────────────────────────────────────

  it('matches a reported name after normalization, and drops anything the SQL returned that does not normalize to the watch', async () => {
    fleet(
      [node('a'), node('b')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
      ],
      [
        { nodeId: 'a', name: '  OpenSSL\t', version: '3.0.13' },
        // A row the SQL spelling let through but the TS spelling does not: re-checked and dropped.
        { nodeId: 'b', name: 'openssl-dev', version: '3.0.13' },
        { nodeId: 'b', name: null, version: '1' },
      ],
    );
    const page = await service.listHosts(WATCH_ID, {}, PAGE);
    expect(page.items.map((h) => [h.id, h.presence])).toEqual([
      ['a', 'INSTALLED'],
      ['b', 'MISSING'],
    ]);
    // The watched names reach the SQL as bound parameters, never concatenated.
    const matchQuery = (queryRaw.mock.calls as unknown[][])[1][0] as {
      values: unknown[];
    };
    expect(matchQuery.values).toContainEqual({ joined: ['openssl'] });
  });

  it('versions: distinct per host, "" and absent share the null bucket, two versions count in two buckets', async () => {
    fleet(
      [node('a'), node('b'), node('c')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
        { id: 'c', hasSoftware: true },
      ],
      [
        { nodeId: 'a', name: 'openssl', version: '3.0.13' },
        { nodeId: 'a', name: 'openssl', version: '1.1.1w' },
        { nodeId: 'b', name: 'openssl', version: '3.0.13' },
        { nodeId: 'b', name: 'openssl', version: '3.0.13' },
        { nodeId: 'c', name: 'openssl', version: '' },
        { nodeId: 'c', name: 'openssl', version: null },
      ],
    );
    const { distribution } = await service.get(WATCH_ID);
    expect(distribution.installed).toBe(3);
    expect(distribution.versions).toEqual([
      { version: '3.0.13', hosts: 2 },
      { version: '1.1.1w', hosts: 1 },
      { version: null, hosts: 1 },
    ]);
  });

  // ── host list: filters, paging, row shape ─────────────────────────────────

  it('pages the filtered host list and counts total over the filter', async () => {
    const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => node(id));
    fleet(
      nodes,
      nodes.map((n) => ({ id: n.id, hasSoftware: true })),
      [
        { nodeId: 'a', name: 'openssl', version: '3' },
        { nodeId: 'c', name: 'openssl', version: '1' },
      ],
    );
    const page = await service.listHosts(
      WATCH_ID,
      { presence: 'MISSING' },
      { limit: 2, offset: 1, deleted: 'active' },
    );
    expect(page).toMatchObject({ total: 3, limit: 2, offset: 1 });
    expect(page.items.map((h) => h.id)).toEqual(['d', 'e']);
  });

  it('filters one version bucket, including the null bucket', async () => {
    fleet(
      [node('a'), node('b'), node('c')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
        { id: 'c', hasSoftware: true },
      ],
      [
        { nodeId: 'a', name: 'openssl', version: '3' },
        { nodeId: 'b', name: 'openssl', version: null },
      ],
    );
    const versioned = await service.listHosts(WATCH_ID, { version: '3' }, PAGE);
    expect(versioned.items.map((h) => h.id)).toEqual(['a']);

    queryRaw.mockReset();
    fleet(
      [node('a'), node('b'), node('c')],
      [
        { id: 'a', hasSoftware: true },
        { id: 'b', hasSoftware: true },
        { id: 'c', hasSoftware: true },
      ],
      [
        { nodeId: 'a', name: 'openssl', version: '3' },
        { nodeId: 'b', name: 'openssl', version: null },
      ],
    );
    const unversioned = await service.listHosts(
      WATCH_ID,
      { version: null },
      PAGE,
    );
    expect(unversioned.items.map((h) => h.id)).toEqual(['b']);
  });

  it('a host row carries liveness and when its inventory was collected; a garbage timestamp reads null', async () => {
    fleet(
      [node('a', { state: 'PENDING', status: 'OFFLINE' }), node('b')],
      [
        {
          id: 'a',
          hasSoftware: true,
          collectedAt: '2026-10-01T10:00:00.000Z',
        },
        { id: 'b', hasSoftware: true, collectedAt: 'garbage' },
      ],
    );
    const page = await service.listHosts(WATCH_ID, {}, PAGE);
    expect(page.items[0]).toEqual({
      id: 'a',
      label: 'a',
      kind: 'PHYSICAL_HOST',
      status: 'OFFLINE',
      pending: true,
      lastReportedAt: '2026-10-21T09:00:00.000Z',
      inventoryCollectedAt: '2026-10-01T10:00:00.000Z',
      presence: 'MISSING',
      versions: [],
      unknownReason: null,
    });
    expect(page.items[1].inventoryCollectedAt).toBeNull();
  });

  // ── list ──────────────────────────────────────────────────────────────────

  it('lists every live watch oldest first from ONE fleet snapshot for all their names', async () => {
    watchFindMany.mockResolvedValue([
      watch({ id: 'w1', name: 'openssl' }),
      watch({ id: 'w2', name: 'curl' }),
    ]);
    fleet(
      [node('a')],
      [{ id: 'a', hasSoftware: true }],
      [{ nodeId: 'a', name: 'curl', version: '8' }],
    );
    const rows = await service.list();
    expect(watchFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(nodeFindMany).toHaveBeenCalledTimes(1);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => [r.name, r.distribution.installed])).toEqual([
      ['openssl', 0],
      ['curl', 1],
    ]);
  });

  it('an empty watchlist touches no node at all', async () => {
    watchFindMany.mockResolvedValue([]);
    expect(await service.list()).toEqual([]);
    expect(nodeFindMany).not.toHaveBeenCalled();
  });

  it('names the author only while that user is live', async () => {
    watchFindMany.mockResolvedValue([
      watch({
        id: 'w1',
        createdById: 'u1',
        createdBy: { firstName: 'Ada', lastName: 'Lovelace', deletedAt: null },
      }),
      watch({
        id: 'w2',
        createdById: 'u2',
        createdBy: {
          firstName: 'Gone',
          lastName: 'User',
          deletedAt: new Date(),
        },
      }),
    ]);
    fleet([], []);
    const rows = await service.list();
    expect(rows.map((r) => r.createdByName)).toEqual(['Ada Lovelace', null]);
  });

  // ── writes ────────────────────────────────────────────────────────────────

  it('create stores the normalized name and the human author', async () => {
    watchFindFirst.mockResolvedValue(null);
    const created = await service.create({ name: '  OpenSSL ' }, HUMAN);
    expect(watchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { name: 'openssl' } }),
    );
    expect(watchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          name: 'openssl',
          createdById: '9f0d1c2b-3a4e-4f5a-8b6c-7d8e9f0a1b2c',
        },
      }),
    );
    expect(created.name).toBe('openssl');
  });

  it('create refuses a second LIVE watch with the same normalized name (409)', async () => {
    watchFindFirst.mockResolvedValue({ id: 'other' });
    await expect(
      service.create({ name: 'OPENSSL' }, HUMAN),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(watchCreate).not.toHaveBeenCalled();
  });

  it(`create refuses past ${SOFTWARE_WATCH_LIMIT} live watches (400)`, async () => {
    watchFindFirst.mockResolvedValue(null);
    watchCount.mockResolvedValue(SOFTWARE_WATCH_LIMIT);
    await expect(
      service.create({ name: 'curl' }, HUMAN),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(watchCreate).not.toHaveBeenCalled();
  });

  it('create by a non-human (should never pass the guard) stores the watch unattributed', async () => {
    watchFindFirst.mockResolvedValue(null);
    await service.create({ name: 'curl' }, {
      kind: 'service',
      serviceAccount: { id: 'sa' },
      permissions: new Set(['infra:manage']),
    } as never);
    expect(watchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { name: 'curl', createdById: null },
      }),
    );
  });

  it('remove SOFT-deletes: an update stamping deletedAt, never a delete', async () => {
    const removed = await service.remove(WATCH_ID);
    expect(watchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: WATCH_ID },
        data: { deletedAt: expect.any(Date) as Date },
      }),
    );
    expect(removed.id).toBe(WATCH_ID);
  });

  it('a deleted or unknown watch is a 404 on every route (findFirst is soft-delete scoped)', async () => {
    watchFindFirst.mockResolvedValue(null);
    await expect(service.get(WATCH_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.listHosts(WATCH_ID, {}, PAGE)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.remove(WATCH_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(watchUpdate).not.toHaveBeenCalled();
    expect(nodeFindMany).not.toHaveBeenCalled();
  });
});
