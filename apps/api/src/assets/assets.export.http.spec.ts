// GET /assets/export over real HTTP (ADR-0103): the real controller, guard, permission resolver, assets
// service and export engine; only the database is a fake.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

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
  assetInventoryCsvHeader,
  coerceRow,
  DATA_EXPORT_ROW_CAP,
  DEFAULT_ROLE_PERMISSIONS,
  ImportMappingSchema,
  IMPORT_DESCRIPTORS,
  type Role,
} from '@lazyit/shared';
import { AssetsController } from './assets.controller';
import { AssetsService } from './assets.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetTagSchemeService } from '../asset-tag-scheme/asset-tag-scheme.service';
import { ArticlesService } from '../articles/articles.service';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { SearchService } from '../search/search.service';
import { ImportDryRunService } from '../import/dry-run.service';
import { parseImport } from '../import/parser';

const PO = 'clpo00000000000000000001';

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

type Row = Record<string, unknown> & { id: string; createdAt: Date };

function assetRow(n: number, overrides: Record<string, unknown> = {}): Row {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + n * 1000);
  return {
    id: `asset${String(n).padStart(6, '0')}`,
    name: `Laptop ${n}`,
    serial: `SN-${n}`,
    assetTag: `LZ-${n}`,
    status: 'OPERATIONAL',
    statusLabelId: null,
    statusLabel: null,
    notes: null,
    company: 'Acme',
    purchaseDate: new Date('2026-01-15T00:00:00.000Z'),
    warrantyEnd: null,
    purchaseCost: BigInt(150050),
    purchaseCurrency: 'USD',
    modelId: null,
    locationId: null,
    createdAt,
    updatedAt: createdAt,
    deletedAt: null,
    model: null,
    location: null,
    assignments: [],
    ...overrides,
  };
}

type KeysetClause = {
  OR: [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }];
};

/** Applies the keyset half of an export batch's `where`; the list filters are asserted separately. */
function afterCursor(rows: Row[], where: Record<string, unknown>): Row[] {
  const and = where.AND as [unknown, KeysetClause] | undefined;
  const keyset = and?.[1]?.OR;
  if (!keyset) return rows;
  const at = keyset[1].createdAt.getTime();
  const id = keyset[1].id.lt;
  return rows.filter(
    (r) =>
      r.createdAt.getTime() < at || (r.createdAt.getTime() === at && r.id < id),
  );
}

function newestFirst(a: Row, b: Row): number {
  return (
    b.createdAt.getTime() - a.createdAt.getTime() ||
    (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
  );
}

describe('GET /assets/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  let table: Row[] = [];
  let onBatch: (call: number) => void = () => {};
  const findMany = jest.fn(
    (args: {
      where: Record<string, unknown>;
      take?: number;
      select?: object;
    }) => {
      onBatch(findMany.mock.calls.length);
      const rows = afterCursor(table, args.where).sort(newestFirst);
      return Promise.resolve(rows.slice(0, args.take ?? rows.length));
    },
  );
  const count = jest.fn(() => Promise.resolve(table.length));
  const create = jest.fn().mockResolvedValue({});
  const prisma = {
    asset: { findMany, count },
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
    $transaction: jest.fn((queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AssetsController],
      providers: [
        Reflector,
        ExportService,
        ExportLimiter,
        AssetsService,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: AssetHistoryService, useValue: {} },
        { provide: SearchService, useValue: {} },
        { provide: AssetTagSchemeService, useValue: {} },
        { provide: AssetAssignmentsService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
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
    table = [assetRow(1), assetRow(2)];
    onBatch = () => {};
    findMany.mockClear();
    count.mockClear();
    create.mockClear();
  });

  const get = (path: string) =>
    request(app.getHttpServer())
      .get(path)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
  const exportCsv = async (query: string) => {
    const res = await get(`/assets/export?${query}`).expect(200);
    return (res.body as Buffer).toString('utf8');
  };
  const lines = (csv: string) => csv.split('\r\n').filter((l) => l !== '');
  const whereOf = (call: number) =>
    (findMany.mock.calls[call] as [{ where: unknown }])[0].where;

  it('streams BOM, the importer stamp, the pinned header and CRLF rows, typed and guarded', async () => {
    table = [
      assetRow(1, { notes: '\n=cmd|/c calc', company: '＝1+1' }),
      assetRow(2),
    ];
    const csv = await exportCsv('role=VIEWER');

    expect(csv.startsWith('﻿# lazyit ')).toBe(true);
    const [, header, newest, oldest] = lines(csv);
    expect(header).toBe(
      'name,assetTag,serial,status,category,manufacturer,model,location,company,purchaseDate,warrantyEnd,owners,notes,createdAt,updatedAt,purchaseCost,purchaseCurrency',
    );
    expect(header).toBe(assetInventoryCsvHeader({ includePurchase: false }));
    expect(newest).toBe(
      'Laptop 2,LZ-2,SN-2,OPERATIONAL,,,,,Acme,2026-01-15T00:00:00.000Z,,,,2026-01-01T00:00:02.000Z,2026-01-01T00:00:02.000Z,1500.50,USD',
    );
    expect(oldest).toContain(`'＝1+1`);
    expect(csv).toContain(`"'\n=cmd|/c calc"`);
    expect(lines(csv)).toHaveLength(4);
  });

  it('appends the provenance columns only for a caller holding purchaseOrder:read', async () => {
    table = [
      assetRow(1, {
        purchaseOrderLine: {
          purchaseOrder: {
            reference: 'OC-4512',
            invoiceNumbers: 'A-1',
            supplier: { name: 'Compumundo' },
          },
        },
      }),
    ];
    const member = lines(await exportCsv('role=MEMBER'));
    expect(member[1]).toBe(assetInventoryCsvHeader({ includePurchase: true }));
    expect(member[2].endsWith(',1500.50,USD,Compumundo,OC-4512,A-1')).toBe(
      true,
    );
    expect(
      (findMany.mock.calls[0] as [{ select: object }])[0].select,
    ).toHaveProperty('purchaseOrderLine');

    findMany.mockClear();
    const viewer = lines(await exportCsv('role=VIEWER'));
    expect(viewer[1]).toBe(assetInventoryCsvHeader({ includePurchase: false }));
    expect(viewer[2]).not.toContain('Compumundo');
    expect(
      (findMany.mock.calls[0] as [{ select: object }])[0].select,
    ).not.toHaveProperty('purchaseOrderLine');
  });

  it('reads the same rows as the list for the same principal and filters (VIEWER)', async () => {
    const filters =
      'q=dell&status=OPERATIONAL&company=Acme&ownership=NONE&warranty=expired&assetTags=LZ-1,LZ-2&serials=SN-1';
    await request(app.getHttpServer())
      .get(`/assets?role=VIEWER&${filters}`)
      .expect(200);
    await exportCsv(`role=VIEWER&${filters}`);

    const listWhere = whereOf(0) as Record<string, unknown>;
    // warrantyWhere reads `now` per call; the instants differ, the clause does not.
    const strip = (w: Record<string, unknown>) => ({
      ...w,
      warrantyEnd: expect.any(Object) as unknown,
    });
    expect(whereOf(1)).toEqual(strip(listWhere));
    expect(count.mock.calls).toHaveLength(2);
    expect(listWhere).toMatchObject({
      status: 'OPERATIONAL',
      company: 'Acme',
      assetTag: { in: ['LZ-1', 'LZ-2'] },
      serial: { in: ['SN-1'] },
      deletedAt: null,
    });
  });

  it('takes the purchase filters with the list’s purchaseOrder:read check', async () => {
    await exportCsv(`role=MEMBER&purchaseOrderId=${PO}`);
    expect(whereOf(0)).toMatchObject({
      AND: [{ purchaseOrderLine: { purchaseOrderId: PO } }],
    });

    findMany.mockClear();
    create.mockClear();
    await get(`/assets/export?role=VIEWER&purchaseOrderId=${PO}`).expect(403);
    await get('/assets/export?role=VIEWER&purchaseLinked=true').expect(403);
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('deleted=only stays ADMIN-only, exactly like the list', async () => {
    for (const role of ['VIEWER', 'MEMBER']) {
      await request(app.getHttpServer())
        .get(`/assets?role=${role}&deleted=only`)
        .expect(403);
      await get(`/assets/export?role=${role}&deleted=only`).expect(403);
    }
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    await exportCsv('role=ADMIN&deleted=only');
    expect(findMany.mock.calls[0][0]).toMatchObject({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
    expect(count).toHaveBeenCalledWith({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
  });

  it('records one audit row with the pre-count and the filters', async () => {
    await exportCsv('role=VIEWER&status=OPERATIONAL&q=dell');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        resource: 'ASSETS',
        rowCount: 2,
        filters: { status: 'OPERATIONAL', q: 'dell', deleted: 'active' },
        serviceAccountId: null,
        actorId: expect.any(String) as unknown,
      },
    });
  });

  it('refuses above the cap with a 422, before any batch or audit row', async () => {
    count.mockResolvedValueOnce(DATA_EXPORT_ROW_CAP + 1);
    await get('/assets/export?role=VIEWER').expect(422);
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('sends every row once when assets are created mid-export (keyset, not OFFSET)', async () => {
    table = Array.from({ length: 2500 }, (_, i) => assetRow(i + 1));
    onBatch = (call) => {
      if (call === 2) {
        table.push(assetRow(9001), assetRow(9002));
      }
    };
    const rows = lines(await exportCsv('role=VIEWER')).slice(2);
    const names = rows.map((r) => r.split(',')[0]);

    expect(findMany).toHaveBeenCalledTimes(3);
    expect(names).toHaveLength(2500);
    expect(new Set(names).size).toBe(2500);
    expect(names[0]).toBe('Laptop 2500');
    expect(names[2499]).toBe('Laptop 1');
  });

  it('round-trips: the exported file parses and passes the import dry-run', async () => {
    table = [
      assetRow(1, { notes: 'Línea "uno", dos', company: 'Dirección' }),
      assetRow(2, { purchaseCost: null, purchaseCurrency: null }),
    ];
    const res = await get('/assets/export?role=ADMIN').expect(200);
    const file = res.body as Buffer;
    expect([...file.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);

    const parsed = parseImport(file, 'csv');
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.dialect.hadBom).toBe(true);
    expect(parsed.headers.join(',')).toBe(
      assetInventoryCsvHeader({ includePurchase: true }),
    );
    expect(parsed.rowCount).toBe(2);
    expect(parsed.raggedRowCount).toBe(0);

    const mapping = ImportMappingSchema.parse({
      columns: [
        'name',
        'assetTag',
        'serial',
        'status',
        'company',
        'notes',
        'purchaseDate',
        'warrantyEnd',
        'purchaseCost',
      ].map((field) => ({ field, column: field })),
    });
    const rows = parsed.rows.map((raw, rowIndex) => ({ rowIndex, raw }));
    const dryRun = new ImportDryRunService({
      asset: { findMany: () => Promise.resolve([]) },
      assetTagScheme: { findFirst: () => Promise.resolve(null) },
    } as unknown as PrismaService);
    const report = await dryRun.analyze(rows, mapping);
    expect(report.result.counts).toMatchObject({
      total: 2,
      valid: 2,
      invalid: 0,
    });

    const older = coerceRow(parsed.rows[1], mapping, IMPORT_DESCRIPTORS.asset);
    expect(older.payload).toMatchObject({
      name: 'Laptop 1',
      notes: 'Línea "uno", dos',
      company: 'Dirección',
      purchaseCost: 150050,
      status: 'OPERATIONAL',
    });
  });
});
