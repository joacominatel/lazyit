import { Test } from '@nestjs/testing';
import {
  DashboardSummarySchema,
  RecentActivityItemSchema,
} from '@lazyit/shared';
import { DashboardService } from './dashboard.service';
import { PrismaService } from '../prisma/prisma.service';

// Mock the generated Prisma client so the test never loads the real one (no DB). The service uses
// the client only for types (erased at runtime) EXCEPT `Prisma.sql` / `Prisma.join` / `Prisma.empty`,
// which it calls at runtime to compose the parameterized activity WHERE (issue #181). We provide a
// faithful-enough tiny SQL builder: each fragment captures its bound `values`, so a test can assert
// the filters are PARAMETERIZED (the injection guard) — never string-concatenated.
jest.mock('../../generated/prisma/client', () => {
  // A minimal Sql node mirroring Prisma's: `strings` (the static template chunks) + `values` (binds).
  class FakeSql {
    constructor(
      readonly strings: readonly string[],
      readonly values: readonly unknown[],
    ) {}
    // A flat text view (binds rendered as `?`) — handy for asserting structure without exposing values.
    get text(): string {
      return this.strings.join('?');
    }
  }
  const EMPTY = new FakeSql([''], []);
  const sql = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): FakeSql => {
    // Flatten nested FakeSql values (Prisma does this so `${Prisma.sql\`...\`}` composes).
    const flatStrings: string[] = [strings[0] ?? ''];
    const flatValues: unknown[] = [];
    values.forEach((value, i) => {
      if (value instanceof FakeSql) {
        flatStrings[flatStrings.length - 1] += value.strings[0] ?? '';
        for (let k = 0; k < value.values.length; k++) {
          flatValues.push(value.values[k]);
          flatStrings.push(value.strings[k + 1] ?? '');
        }
        flatStrings[flatStrings.length - 1] += strings[i + 1] ?? '';
      } else {
        flatValues.push(value);
        flatStrings.push(strings[i + 1] ?? '');
      }
    });
    return new FakeSql(flatStrings, flatValues);
  };
  const join = (parts: FakeSql[], separator: string): FakeSql => {
    if (parts.length === 0) return EMPTY;
    const strings: string[] = [''];
    const valuesOut: unknown[] = [];
    parts.forEach((part, i) => {
      strings[strings.length - 1] += part.strings[0] ?? '';
      for (let k = 0; k < part.values.length; k++) {
        valuesOut.push(part.values[k]);
        strings.push(part.strings[k + 1] ?? '');
      }
      if (i < parts.length - 1) strings[strings.length - 1] += separator;
    });
    return new FakeSql(strings, valuesOut);
  };
  return {
    PrismaClient: class {},
    Prisma: { sql, join, empty: EMPTY, Sql: FakeSql },
  };
});

/**
 * Unit spec for the read-only dashboard aggregation. PrismaService is fully mocked: each model's
 * count/groupBy/findMany returns a canned value, and we assert (a) the composed shape validates
 * against the shared DashboardSummarySchema and (b) the non-trivial derivations — zero-filled
 * status buckets, distinct assigned-asset count, low-stock post-filter, expiring-soon window,
 * critical-app filter and draft = total - published.
 */

type PrismaMock = {
  asset: { count: jest.Mock; groupBy: jest.Mock };
  assetAssignment: { groupBy: jest.Mock };
  accessGrant: { count: jest.Mock };
  consumable: { count: jest.Mock; findMany: jest.Mock };
  article: { count: jest.Mock };
  assetHistory: { findMany: jest.Mock };
  $queryRaw: jest.Mock;
  $transaction: jest.Mock;
};

function buildPrismaMock(): PrismaMock {
  return {
    asset: { count: jest.fn(), groupBy: jest.fn() },
    assetAssignment: { groupBy: jest.fn() },
    accessGrant: { count: jest.fn() },
    consumable: { count: jest.fn(), findMany: jest.fn() },
    article: { count: jest.fn() },
    assetHistory: { findMany: jest.fn() },
    // $queryRaw returns a sentinel "query handle"; $transaction resolves the array of handles to
    // canned results — mirroring how getActivity batches the page read + the count.
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  };
}

async function buildService(prisma: PrismaMock): Promise<DashboardService> {
  const moduleRef = await Test.createTestingModule({
    providers: [DashboardService, { provide: PrismaService, useValue: prisma }],
  }).compile();
  return moduleRef.get(DashboardService);
}

describe('DashboardService', () => {
  let prisma: PrismaMock;
  let service: DashboardService;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    service = await buildService(prisma);

    // --- Inventory ---
    prisma.asset.count.mockResolvedValue(12);
    prisma.asset.groupBy.mockResolvedValue([
      { status: 'OPERATIONAL', _count: { _all: 8 } },
      { status: 'IN_MAINTENANCE', _count: { _all: 3 } },
      { status: 'RETIRED', _count: { _all: 1 } },
    ]);
    // Three rows => three distinct assigned assets (multi-owner collapses to one row each).
    prisma.assetAssignment.groupBy.mockResolvedValue([
      { assetId: 'a1' },
      { assetId: 'a2' },
      { assetId: 'a3' },
    ]);

    // --- Access: accessGrant.count is called 3x in order (active, expiringSoon, critical) ---
    prisma.accessGrant.count
      .mockResolvedValueOnce(20) // activeGrants
      .mockResolvedValueOnce(4) // expiringSoon
      .mockResolvedValueOnce(2); // onCriticalApps

    // --- Consumables ---
    prisma.consumable.count.mockResolvedValue(7);
    prisma.consumable.findMany.mockResolvedValue([
      { currentStock: 0, minStock: 5 }, // low
      { currentStock: 5, minStock: 5 }, // low (at threshold)
      { currentStock: 6, minStock: 5 }, // ok
      { currentStock: 2, minStock: 10 }, // low
    ]);

    // --- Knowledge: article.count called 2x (total, published) ---
    prisma.article.count
      .mockResolvedValueOnce(9) // total
      .mockResolvedValueOnce(6); // published

    // --- Recent activity ---
    prisma.assetHistory.findMany.mockResolvedValue([
      {
        id: 42,
        assetId: 'casset0000000000000000001',
        eventType: 'STATUS_CHANGED',
        payload: { from: 'OPERATIONAL', to: 'IN_MAINTENANCE' },
        performedById: '11111111-1111-4111-8111-111111111111',
        createdAt: new Date('2026-05-30T10:00:00.000Z'),
      },
      {
        id: 41,
        assetId: 'casset0000000000000000002',
        eventType: 'CREATED',
        payload: null,
        performedById: null,
        createdAt: new Date('2026-05-29T09:00:00.000Z'),
      },
    ]);
  });

  it('returns a payload that satisfies DashboardSummarySchema', async () => {
    const summary = await service.getSummary();
    expect(() => DashboardSummarySchema.parse(summary)).not.toThrow();
  });

  it('zero-fills every AssetStatus bucket and reflects the groupBy counts', async () => {
    const { assets } = await service.getSummary();
    expect(assets.total).toBe(12);
    expect(assets.byStatus).toEqual({
      OPERATIONAL: 8,
      IN_MAINTENANCE: 3,
      IN_STORAGE: 0,
      RETIRED: 1,
      LOST: 0,
      UNKNOWN: 0,
    });
    expect(assets.assigned).toBe(3);
  });

  it('counts active assignments as distinct assets via groupBy on assetId', async () => {
    await service.getSummary();
    expect(prisma.assetAssignment.groupBy).toHaveBeenCalledWith({
      by: ['assetId'],
      where: { releasedAt: null },
    });
  });

  it('computes the access slice and echoes the expiry window', async () => {
    const { access } = await service.getSummary(45);
    expect(access).toEqual({
      activeGrants: 20,
      expiringSoon: 4,
      expiringWithinDays: 45,
      onCriticalApps: 2,
    });
  });

  it('queries expiringSoon within a (now, now + N days] window on active grants', async () => {
    const before = Date.now();
    await service.getSummary(10);
    const after = Date.now();

    // 2nd accessGrant.count call is expiringSoon.
    const expiringArgs = prisma.accessGrant.count.mock.calls[1][0];
    expect(expiringArgs.where.revokedAt).toBeNull();
    const { gt, lte } = expiringArgs.where.expiresAt;
    expect((gt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((gt as Date).getTime()).toBeLessThanOrEqual(after);
    const windowMs = (lte as Date).getTime() - (gt as Date).getTime();
    expect(windowMs).toBe(10 * 24 * 60 * 60 * 1000);
  });

  it('filters critical-app grants to active grants on isCritical applications', async () => {
    await service.getSummary();
    // 3rd accessGrant.count call is onCriticalApps.
    expect(prisma.accessGrant.count.mock.calls[2][0]).toEqual({
      where: { revokedAt: null, application: { is: { isCritical: true } } },
    });
  });

  it('post-filters low stock to currentStock <= minStock (and ignores null minStock via the query)', async () => {
    const { consumables } = await service.getSummary();
    expect(consumables.total).toBe(7);
    expect(consumables.lowStock).toBe(3);
    expect(prisma.consumable.findMany).toHaveBeenCalledWith({
      where: { minStock: { not: null } },
      select: { currentStock: true, minStock: true },
    });
  });

  it('derives draft articles as total minus published', async () => {
    const { articles } = await service.getSummary();
    expect(articles).toEqual({ total: 9, published: 6, draft: 3 });
  });

  it('maps recent activity newest-first with ISO timestamps', async () => {
    const { recentActivity } = await service.getSummary();
    expect(prisma.assetHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { id: 'desc' }, take: 10 }),
    );
    expect(recentActivity).toHaveLength(2);
    expect(recentActivity[0]).toEqual({
      id: 42,
      assetId: 'casset0000000000000000001',
      eventType: 'STATUS_CHANGED',
      payload: { from: 'OPERATIONAL', to: 'IN_MAINTENANCE' },
      performedById: '11111111-1111-4111-8111-111111111111',
      createdAt: '2026-05-30T10:00:00.000Z',
    });
    expect(recentActivity[1].payload).toBeNull();
    expect(recentActivity[1].createdAt).toBe('2026-05-29T09:00:00.000Z');
  });

  it('stamps generatedAt as an ISO-8601 string', async () => {
    const summary = await service.getSummary();
    expect(Number.isNaN(Date.parse(summary.generatedAt))).toBe(false);
  });

  describe('getActivity (recent_activity view read + shaping)', () => {
    // One row per source, exactly as the recent_activity view + actor LEFT JOIN return them: the pg
    // driver maps occurredAt (timestamptz) to a JS Date, and actorId/actorName are nullable.
    const viewRows = [
      {
        occurredAt: new Date('2026-05-31T12:00:00.000Z'),
        actorId: '11111111-1111-4111-8111-111111111111',
        actorName: 'Admin User',
        entityType: 'consumable',
        entityId: 'cconsum000000000000000001',
        action: 'stock_in',
        summary: 'Stock added: +10',
        // Subject enrichment (issue #311): a consumable movement names the consumable, no target user.
        subjectName: 'HDMI cables',
        targetUserId: null,
        targetUserName: null,
      },
      {
        occurredAt: new Date('2026-05-31T11:00:00.000Z'),
        actorId: '11111111-1111-4111-8111-111111111111',
        actorName: 'Admin User',
        entityType: 'application',
        entityId: 'capp00000000000000000001',
        action: 'granted',
        summary: 'Access granted to a user',
        // The headline case: which app + which user the grant is about.
        subjectName: 'GitHub',
        targetUserId: '22222222-2222-4222-8222-222222222222',
        targetUserName: 'Jane Doe',
      },
      {
        occurredAt: new Date('2026-05-31T10:00:00.000Z'),
        actorId: null,
        actorName: null,
        entityType: 'asset',
        entityId: 'casset0000000000000000001',
        action: 'created',
        summary: 'Asset created',
        // An asset state change names the asset; no person subject.
        subjectName: 'MacBook Pro 16',
        targetUserId: null,
        targetUserName: null,
      },
    ];

    beforeEach(() => {
      // $queryRaw is called twice (page slice, then count); $transaction resolves the [page, count]
      // array of handles to the canned results.
      prisma.$queryRaw
        .mockReturnValueOnce('PAGE_QUERY')
        .mockReturnValueOnce('COUNT_QUERY');
      prisma.$transaction.mockResolvedValue([viewRows, [{ count: 3n }]]);
    });

    it('returns a Page<RecentActivityItem> with ISO timestamps and the echoed window', async () => {
      const page = await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
      });
      expect(page.total).toBe(3);
      expect(page.limit).toBe(20);
      expect(page.offset).toBe(0);
      expect(page.items).toHaveLength(3);
      expect(page.items[0]).toEqual({
        occurredAt: '2026-05-31T12:00:00.000Z',
        actorId: '11111111-1111-4111-8111-111111111111',
        actorName: 'Admin User',
        entityType: 'consumable',
        entityId: 'cconsum000000000000000001',
        action: 'stock_in',
        summary: 'Stock added: +10',
        subjectName: 'HDMI cables',
        targetUserId: null,
        targetUserName: null,
      });
    });

    it('surfaces the resolved subject (app name) + target user the event concerns (issue #311)', async () => {
      const page = await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
      });
      const grantRow = page.items.find((i) => i.action === 'granted');
      expect(grantRow?.subjectName).toBe('GitHub');
      expect(grantRow?.targetUserId).toBe(
        '22222222-2222-4222-8222-222222222222',
      );
      expect(grantRow?.targetUserName).toBe('Jane Doe');
    });

    it('selects the subject columns from the view (subjectName / targetUserId / targetUserName)', async () => {
      await service.getActivity({ limit: 20, offset: 0, deleted: 'active' });
      const pageText = (
        prisma.$queryRaw.mock.calls[0][0] as { text: string }
      ).text;
      expect(pageText).toContain('ra."subjectName"');
      expect(pageText).toContain('ra."targetUserId"');
      expect(pageText).toContain('ra."targetUserName"');
    });

    it('keeps a null actor (system / unknown / deleted actor) as null id + name', async () => {
      const page = await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
      });
      const assetRow = page.items.find((i) => i.entityType === 'asset');
      expect(assetRow?.actorId).toBeNull();
      expect(assetRow?.actorName).toBeNull();
    });

    it('every returned row validates against the shared RecentActivityItemSchema', async () => {
      const page = await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
      });
      for (const item of page.items) {
        expect(() => RecentActivityItemSchema.parse(item)).not.toThrow();
      }
    });

    it('batches the page read and the count in a single $transaction', async () => {
      await service.getActivity({ limit: 20, offset: 0, deleted: 'active' });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction).toHaveBeenCalledWith([
        'PAGE_QUERY',
        'COUNT_QUERY',
      ]);
    });

    it('coerces a bigint count from COUNT(*)::bigint to a JS number', async () => {
      prisma.$transaction.mockResolvedValue([viewRows, [{ count: 42n }]]);
      const page = await service.getActivity({
        limit: 20,
        offset: 10,
        deleted: 'active',
      });
      expect(page.total).toBe(42);
      expect(typeof page.total).toBe('number');
      expect(page.offset).toBe(10);
    });

    /**
     * Filtering (issue #181 / DEBT-1). The Prisma mock builds a faithful `FakeSql` node per query, so
     * we read back the SQL the service composed (`$queryRaw.mock.calls[i][0]`): `.text` shows the
     * structure (binds rendered as `?`), `.values` shows the bound parameters — proving the filters
     * are PARAMETERIZED, never concatenated, and that the page + count share the same WHERE.
     */
    const pageSql = () => prisma.$queryRaw.mock.calls[0][0] as {
      text: string;
      values: unknown[];
    };
    const countSql = () => prisma.$queryRaw.mock.calls[1][0] as {
      text: string;
      values: unknown[];
    };

    it('emits NO WHERE clause when no filter is supplied (backward-compatible)', async () => {
      await service.getActivity({ limit: 20, offset: 0, deleted: 'active' });
      expect(pageSql().text).not.toContain('WHERE');
      expect(countSql().text).not.toContain('WHERE');
    });

    it('applies entityType / entityId / action as bound parameters (no concatenation)', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        entityType: 'asset',
        entityId: 'casset0000000000000000001',
        action: 'created',
      });
      const page = pageSql();
      expect(page.text).toContain('WHERE');
      expect(page.text).toContain('ra."entityType" =');
      expect(page.text).toContain('ra."entityId" =');
      expect(page.text).toContain('ra."action" =');
      // The user-controlled values are BOUND, not inlined into the SQL text.
      expect(page.values).toEqual(
        expect.arrayContaining([
          'asset',
          'casset0000000000000000001',
          'created',
        ]),
      );
    });

    it('binds an already-resolved actorId (cast to uuid) — the service never sees "me"', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        actorId: '11111111-1111-4111-8111-111111111111',
      });
      const page = pageSql();
      expect(page.text).toContain('ra."actorId" =');
      expect(page.text).toContain('::uuid');
      expect(page.values).toContain('11111111-1111-4111-8111-111111111111');
    });

    it('applies a closed-open [from, to) window over occurredAt as bound timestamps', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        from: '2026-05-01T00:00:00.000Z',
        to: '2026-06-01T00:00:00.000Z',
      });
      const page = pageSql();
      expect(page.text).toContain('ra."occurredAt" >=');
      expect(page.text).toContain('ra."occurredAt" <');
      const dates = page.values.filter((v) => v instanceof Date);
      expect(dates.map((d) => d.toISOString())).toEqual([
        '2026-05-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      ]);
    });

    it('wraps the free-text q in ILIKE wildcards as a single bound parameter on both summary and actor name', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        q: 'laptop',
      });
      const page = pageSql();
      expect(page.text).toContain('ILIKE');
      expect(page.text).toContain('ra."summary"');
      expect(page.text).toContain('firstName');
      // The wildcards wrap the bound VALUE — the user text stays a parameter, never SQL structure.
      expect(page.values).toContain('%laptop%');
    });

    it('escapes LIKE wildcards in q (%, _, \\) so they match literally, with an ESCAPE clause (issue #593)', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        q: '50%_a\\b',
      });
      const page = pageSql();
      // The `%`/`_`/`\` typed by the user are escaped INSIDE the bound pattern, so only the outer
      // wrapping `%...%` are real wildcards — a literal `50%_a\b` matches itself, not every row.
      expect(page.values).toContain('%50\\%\\_a\\\\b%');
      expect(page.values).not.toContain('%50%_a\\b%');
      // The composed SQL pairs the ILIKE with an ESCAPE clause so Postgres reads `\%`/`\_`/`\\`
      // as the literal characters.
      expect(page.text).toContain('ESCAPE');
    });

    it('the count query carries the SAME filtered WHERE as the page query (total = filtered count)', async () => {
      await service.getActivity({
        limit: 20,
        offset: 0,
        deleted: 'active',
        entityType: 'asset',
        q: 'created',
      });
      const page = pageSql();
      const count = countSql();
      expect(count.text).toContain('WHERE');
      expect(count.text).toContain('ra."entityType" =');
      expect(count.text).toContain('ILIKE');
      // Identical WHERE binds on both halves → the total can't drift from the page. The page also
      // binds the trailing LIMIT/OFFSET (take, skip), so compare the leading WHERE values only.
      expect(page.values.slice(0, count.values.length)).toEqual(count.values);
      // entityType bind, then the q pattern + ESCAPE char bound twice (summary + actor-name ILIKE).
      expect(count.values).toEqual([
        'asset',
        '%created%',
        '\\',
        '%created%',
        '\\',
      ]);
    });
  });
});
