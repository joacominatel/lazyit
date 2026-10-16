// GET /dashboard/activity/export (ADR-0103): the keyset over the view's (occurredAt, sourceKey), the feed's
// own filters, and the route over real HTTP with the real guard, resolver and export engine. No database:
// `Prisma.sql` is a small faithful builder, and `$queryRaw` answers from an in-memory view.
jest.mock('../../generated/prisma/client', () => {
  class FakeSql {
    constructor(
      readonly strings: readonly string[],
      readonly values: readonly unknown[],
    ) {}
  }
  const EMPTY = new FakeSql([''], []);
  const flatten = (strings: readonly string[], values: unknown[]): FakeSql => {
    const out: string[] = [strings[0] ?? ''];
    const vals: unknown[] = [];
    values.forEach((value, i) => {
      if (value instanceof FakeSql) {
        out[out.length - 1] += value.strings[0] ?? '';
        value.values.forEach((v, k) => {
          vals.push(v);
          out.push(value.strings[k + 1] ?? '');
        });
        out[out.length - 1] += strings[i + 1] ?? '';
      } else {
        vals.push(value);
        out.push(strings[i + 1] ?? '');
      }
    });
    return new FakeSql(out, vals);
  };
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) =>
    flatten(Array.from(strings), values);
  const join = (parts: FakeSql[], separator: string): FakeSql => {
    if (parts.length === 0) return EMPTY;
    const strings = ['', ...parts.slice(1).map(() => separator), ''];
    return flatten(strings, parts);
  };
  return {
    PrismaClient: class {},
    Prisma: { sql, join, empty: EMPTY },
  };
});

import { randomUUID } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, APP_PIPE, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ZodValidationPipe } from 'nestjs-zod';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  DATA_EXPORT_ROW_CAP,
  DEFAULT_ROLE_PERMISSIONS,
  RECENT_ACTIVITY_CSV_HEADER,
  type Role,
} from '@lazyit/shared';
import { DashboardController } from './dashboard.controller';
import { DashboardService, type ActivityExportRow } from './dashboard.service';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { keysetBatches } from '../common/export/keyset';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';

type Node = { strings: readonly string[]; values: readonly unknown[] };
const text = (node: Node) => node.strings.join('?').replace(/\s+/g, ' ');

interface ViewRow {
  occurredAt: Date;
  sourceKey: string;
  actorId: string | null;
  actorName: string | null;
  entityType: 'asset' | 'application' | 'consumable' | 'user';
  entityId: string;
  action: string;
  summary: string;
  subjectName: string | null;
  targetUserId: string | null;
  targetUserName: string | null;
}

const KEYSET = '(ra."occurredAt", ra."sourceKey") < (?::timestamptz, ?)';

function event(
  occurredAt: string,
  sourceKey: string,
  overrides: Partial<ViewRow> = {},
): ViewRow {
  return {
    occurredAt: new Date(occurredAt),
    sourceKey,
    actorId: null,
    actorName: 'Ana Admin',
    entityType: 'application',
    entityId: 'app1',
    action: 'revoked',
    summary: 'Access revoked from a user',
    subjectName: 'Slack',
    targetUserId: null,
    targetUserName: null,
    ...overrides,
  };
}

const newestFirst = (a: ViewRow, b: ViewRow) =>
  b.occurredAt.getTime() - a.occurredAt.getTime() ||
  (a.sourceKey < b.sourceKey ? 1 : a.sourceKey > b.sourceKey ? -1 : 0);

/** Answers the export's two queries from `view`, honouring the keyset predicate and LIMIT; filters are asserted on the SQL. */
function viewDouble(view: () => ViewRow[]) {
  return jest.fn((node: Node) => {
    const sql = text(node);
    if (sql.includes('COUNT(*)')) {
      return Promise.resolve([{ count: BigInt(view().length) }]);
    }
    let rows = [...view()].sort(newestFirst);
    if (sql.includes(KEYSET)) {
      const at = node.values.length - 3;
      const t = (node.values[at] as Date).getTime();
      const k = node.values[at + 1] as string;
      rows = rows.filter(
        (r) =>
          r.occurredAt.getTime() < t ||
          (r.occurredAt.getTime() === t && r.sourceKey < k),
      );
    }
    const limit = node.values[node.values.length - 1] as number;
    return Promise.resolve(rows.slice(0, limit));
  });
}

describe('DashboardService.activityExport (keyset over the view, ADR-0103)', () => {
  it('reads newest first by (occurredAt, sourceKey) and continues strictly below the cursor', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const service = new DashboardService({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    const { fetchBatch } = service.activityExport({ action: 'revoked' });
    const cursor = {
      createdAt: new Date('2026-10-16T10:00:00.123Z'),
      id: 'access_grants:g9:revoked',
    };

    await fetchBatch(null, 1000);
    await fetchBatch(cursor, 1000);

    const [first, second] = (queryRaw.mock.calls as Array<[Node]>).map(
      ([node]) => node,
    );
    expect(text(first)).toContain('ra."sourceKey" FROM "recent_activity" ra');
    expect(text(first)).toContain(
      'ORDER BY ra."occurredAt" DESC, ra."sourceKey" DESC LIMIT ?',
    );
    expect(text(first)).not.toContain(KEYSET);
    expect(first.values).toEqual(['revoked', 1000]);
    expect(text(second)).toContain(`WHERE ra."action" = ? AND ${KEYSET}`);
    // The Date itself, never an ISO string: the adapter writes it back as the wall-clock it read.
    expect(second.values).toEqual([
      'revoked',
      cursor.createdAt,
      'access_grants:g9:revoked',
      1000,
    ]);
  });

  it('counts and reads with the exact WHERE the feed builds for the same filters', async () => {
    const queryRaw = jest.fn((node: Node) =>
      Promise.resolve(
        text(node).includes('COUNT(*)') ? [{ count: BigInt(0) }] : [],
      ),
    );
    const prisma = {
      $queryRaw: queryRaw,
      $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    } as unknown as PrismaService;
    const service = new DashboardService(prisma);
    const filters = {
      entityType: 'asset' as const,
      entityId: 'casset1',
      actorId: '11111111-1111-4111-8111-111111111111',
      action: 'assigned' as const,
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-16T00:00:00.000Z',
      q: '50%',
    };

    await service.getActivity({
      ...filters,
      limit: 50,
      offset: 0,
      deleted: 'active',
    });
    const { count, fetchBatch } = service.activityExport(filters);
    await count();
    await fetchBatch(null, 1000);

    const [feedPage, feedCount, exportCount, exportBatch] = (
      queryRaw.mock.calls as Array<[Node]>
    ).map(([node]) => node);
    const whereOf = (node: Node) =>
      /WHERE .*?(?= ORDER BY|$)/.exec(text(node).trim())?.[0];
    expect(whereOf(exportBatch)).toBe(whereOf(feedPage));
    expect(text(exportCount)).toBe(text(feedCount));
    expect(exportCount.values).toEqual(feedCount.values);
    expect(exportBatch.values.slice(0, -1)).toEqual(feedCount.values);
  });

  it('sends every event once across a tie on occurredAt, and never one recorded mid-export', async () => {
    const tie = '2026-10-16T09:00:00.000Z';
    const view: ViewRow[] = [
      event('2026-10-16T09:30:00.000Z', 'asset_history:7', {
        entityType: 'asset',
        action: 'created',
      }),
      // An offboarding revokes five grants at one instant.
      ...['g1', 'g2', 'g3', 'g4', 'g5'].map((g) =>
        event(tie, `access_grants:${g}:revoked`),
      ),
      event('2026-10-16T08:00:00.000Z', 'asset_assignments:a1:assigned'),
      event('2026-10-16T08:00:00.000Z', 'asset_assignments:a1:released'),
    ];
    const queryRaw = viewDouble(() => view);
    const service = new DashboardService({
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    const { fetchBatch } = service.activityExport({});

    const sent: string[] = [];
    let batches = 0;
    for await (const batch of keysetBatches<ActivityExportRow>(fetchBatch, 2)) {
      sent.push(...batch.map((r) => r.sourceKey));
      if (++batches === 1) {
        view.push(event('2026-10-16T10:00:00.000Z', 'user_history:99'));
      }
    }

    expect(sent).toEqual([
      'asset_history:7',
      'access_grants:g5:revoked',
      'access_grants:g4:revoked',
      'access_grants:g3:revoked',
      'access_grants:g2:revoked',
      'access_grants:g1:revoked',
      'asset_assignments:a1:released',
      'asset_assignments:a1:assigned',
    ]);
  });
});

/** `?role=` impersonates a human of that role; a fresh id per request keeps the export limiter out of the way. */
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const role = (req.query as Record<string, string>).role;
    const user = { id: randomUUID(), role };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

describe('GET /dashboard/activity/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  let view: ViewRow[] = [];
  const queryRaw = viewDouble(() => view);
  const create = jest.fn().mockResolvedValue({});
  const prisma = {
    $queryRaw: queryRaw,
    $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
    dataExportLog: { create },
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [DashboardController],
      providers: [
        Reflector,
        DashboardService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_PIPE, useClass: ZodValidationPipe },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    view = [
      event('2026-10-16T09:00:00.000Z', 'access_grants:g1:revoked', {
        actorName: '=cmd|/c calc',
        summary: 'a,b "q"\nz',
      }),
      event('2026-10-16T08:00:00.000Z', 'consumable_movements:4', {
        entityType: 'consumable',
        entityId: 'ccons1',
        action: 'stock_out',
        summary: 'Stock removed: -5',
      }),
    ];
    queryRaw.mockClear();
    create.mockClear();
  });

  const exportCsv = (query: string) =>
    request(app.getHttpServer())
      .get(`/dashboard/activity/export?${query}`)
      .buffer(true)
      .parse((res, done) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => done(null, body));
      });

  it('is logs:read like the feed: a VIEWER and a MEMBER are refused both', async () => {
    for (const role of ['VIEWER', 'MEMBER']) {
      await request(app.getHttpServer())
        .get(`/dashboard/activity?role=${role}`)
        .expect(403);
      await exportCsv(`role=${role}`).expect(403);
    }
    expect(queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('streams BOM, the pinned header (no stamp) and guarded CRLF rows', async () => {
    const res = await exportCsv('role=ADMIN').expect(200);
    const body = res.body as string;

    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-activity-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(body.startsWith(`\uFEFF${RECENT_ACTIVITY_CSV_HEADER}\r\n`)).toBe(
      true,
    );
    expect(RECENT_ACTIVITY_CSV_HEADER).toBe(
      'occurredAt,action,entityType,entityId,actorName,summary',
    );
    expect(body).not.toContain('# lazyit');
    expect(body).toBe(
      `\uFEFF${RECENT_ACTIVITY_CSV_HEADER}\r\n` +
        `2026-10-16T09:00:00.000Z,revoked,application,app1,'=cmd|/c calc,"a,b ""q""\nz"\r\n` +
        '2026-10-16T08:00:00.000Z,stock_out,consumable,ccons1,Ana Admin,Stock removed: -5\r\n',
    );
  });

  it('reads the same WHERE as the feed for the same filters, "me" resolved to the caller', async () => {
    const filters =
      'entityType=application&action=revoked&from=2026-10-01T00:00:00.000Z&q=slack&actorId=me';
    await request(app.getHttpServer())
      .get(`/dashboard/activity?role=ADMIN&${filters}`)
      .expect(200);
    await exportCsv(`role=ADMIN&${filters}`).expect(200);

    const [feedPage, , exportCount, exportBatch] = (
      queryRaw.mock.calls as Array<[Node]>
    ).map(([node]) => node);
    const whereOf = (node: Node) =>
      /WHERE .*?(?= ORDER BY|$)/.exec(text(node).trim())?.[0];
    expect(whereOf(exportBatch)).toBe(whereOf(feedPage));
    expect(whereOf(exportCount)).toBe(whereOf(feedPage));
    // Each request is its own caller, so only the resolved actor id differs.
    expect(exportBatch.values.slice(0, -1)).toHaveLength(
      feedPage.values.length - 2,
    );
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'ACTIVITY',
        rowCount: 2,
        filters: expect.objectContaining({
          entityType: 'application',
          action: 'revoked',
          q: 'slack',
          actorId: expect.any(String) as unknown,
        }) as unknown,
      }) as unknown,
    });
  });

  it('refuses above the cap with a 422, before any batch or audit row', async () => {
    view = Array.from({ length: DATA_EXPORT_ROW_CAP + 1 }, () =>
      event('2026-10-16T09:00:00.000Z', 'x'),
    );
    await exportCsv('role=ADMIN').expect(422);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });
});
