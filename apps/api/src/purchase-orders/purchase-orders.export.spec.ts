jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));
jest.mock('@prisma/adapter-pg', () => ({ PrismaPg: class {} }));
jest.mock('meilisearch', () => ({ Meilisearch: jest.fn() }));

import {
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DEFAULT_ROLE_PERMISSIONS, type Role } from '@lazyit/shared';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { XLSX_CONTENT_TYPE } from '../common/export';
import { XLSX_STYLE } from '../common/export/xlsx-sheet';
import { readXlsx, xlsxRecords } from '../../test/xlsx-reader';
import { PurchaseOrdersController } from './purchase-orders.controller';
import {
  PurchaseOrdersService,
  type PurchaseOrderFilters,
} from './purchase-orders.service';
import { PurchaseReceivingService } from './purchase-receiving.service';
import { PurchaseLicenseService } from './purchase-license.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';
import { PurchaseExtractionService } from './extraction/purchase-extraction.service';

const SUPPLIER = 'clsupplier00000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

function purchaseRow(over: Row = {}): Row {
  return {
    id: 'clpo00000000000000000001',
    reference: 'OC-1',
    supplierId: SUPPLIER,
    status: 'ORDERED',
    currency: 'USD',
    orderDate: new Date('2026-10-01T00:00:00.000Z'),
    expectedDate: null,
    deliveryLocationId: null,
    company: 'Acme',
    invoiceNumbers: 'F-1, F-2',
    invoiceDate: null,
    notes: 'never exported',
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
    updatedAt: new Date('2026-10-02T10:00:00.000Z'),
    deletedAt: null,
    supplier: { id: SUPPLIER, name: 'Compumundo', deletedAt: null },
    lines: [],
    ...over,
  };
}

function lineRow(over: Row = {}): Row {
  return {
    id: 'clline000000000000000001',
    purchaseOrderId: 'clpo00000000000000000001',
    position: 0,
    kind: 'ASSET',
    description: 'Laptop',
    quantity: 1,
    unitPrice: null,
    cancelledQuantity: 0,
    deletedAt: null,
    ...over,
  };
}

function makePrisma() {
  return {
    purchaseOrder: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    purchaseOrderLine: { findMany: jest.fn().mockResolvedValue([]) },
    asset: { groupBy: jest.fn().mockResolvedValue([]) },
    consumableMovement: { groupBy: jest.fn().mockResolvedValue([]) },
    dataExportLog: { create: jest.fn().mockResolvedValue({}) },
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
    $queryRaw: jest.fn().mockResolvedValue([
      {
        purchaseOrderId: 'clpoPending000000000001',
        kind: 'ASSET',
        quantity: 2,
        cancelledQuantity: 0,
        received: 1,
      },
      {
        purchaseOrderId: 'clpoDone0000000000000001',
        kind: 'ASSET',
        quantity: 1,
        cancelledQuantity: 0,
        received: 1,
      },
    ]),
    $transaction: jest.fn((queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };
}

type FakePrisma = ReturnType<typeof makePrisma>;

function serviceOver(prisma: FakePrisma): PurchaseOrdersService {
  return new PurchaseOrdersService(
    prisma as unknown as PrismaService,
    new ActorService(),
  );
}

describe('PurchaseOrdersService.exportSource — the list rows (ADR-0103)', () => {
  const cases: [string, PurchaseOrderFilters][] = [
    ['no filter', {}],
    ['q + status', { q: 'dell', status: ['ORDERED', 'CANCELLED'] }],
    ['supplier', { supplierId: SUPPLIER }],
    ['receipt PENDING', { receipt: 'PENDING' }],
    ['receipt RECEIVED', { receipt: 'RECEIVED' }],
  ];

  describe.each(['active', 'only'] as const)('deleted=%s', (deleted) => {
    it.each(cases)(
      '%s: count and first batch read the list where',
      async (_name, filters) => {
        const prisma = makePrisma();
        const service = serviceOver(prisma);

        await service.findPage(filters, { limit: 50, offset: 0, deleted });
        const source = service.exportSource(filters, deleted);
        await source.count();
        await source.fetchBatch(null, 1000);

        const [listFind] = prisma.purchaseOrder.findMany.mock.calls[0] as [Row];
        const [listCount] = prisma.purchaseOrder.count.mock.calls[0] as [Row];
        const [exportCount] = prisma.purchaseOrder.count.mock.calls[1] as [Row];
        const [exportFind] = prisma.purchaseOrder.findMany.mock.calls[1] as [
          Row,
        ];
        expect(exportCount).toEqual(listCount);
        expect(exportFind.where).toEqual(listFind.where);
        expect(exportFind.include).toEqual(listFind.include);
        expect(exportFind.includeSoftDeleted).toEqual(
          listFind.includeSoftDeleted,
        );
        expect(exportFind.orderBy).toEqual([
          { createdAt: 'desc' },
          { id: 'desc' },
        ]);
      },
    );
  });

  it('resolves the receipt filter lazily and once: every batch reads the id set that was counted', async () => {
    const prisma = makePrisma();
    const source = serviceOver(prisma).exportSource(
      { receipt: 'PENDING' },
      'active',
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await source.count();
    await source.fetchBatch(null, 1000);
    await source.fetchBatch(
      { createdAt: new Date('2026-10-01T00:00:00Z'), id: 'clpoX' },
      1000,
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('a batch row is the list row: derived receipt, totals and line count', async () => {
    const prisma = makePrisma();
    const row = purchaseRow({
      lines: [lineRow({ quantity: 2, unitPrice: 123456n })],
    });
    prisma.purchaseOrder.findMany.mockResolvedValue([row]);
    prisma.asset.groupBy.mockResolvedValue([
      { purchaseOrderLineId: 'clline000000000000000001', _count: { _all: 1 } },
    ]);
    const service = serviceOver(prisma);

    const page = await service.findPage(
      {},
      { limit: 50, offset: 0, deleted: 'active' },
    );
    const source = service.exportSource({}, 'active');
    const batch = await source.fetchBatch(null, 1000);

    expect(batch).toEqual(page.items);
    expect(batch[0]).toMatchObject({
      lineCount: 1,
      receipt: { state: 'PARTIAL', ordered: 2, received: 1, pending: 1 },
      totals: [{ currency: 'USD', amount: 246912, unpricedLines: 0 }],
    });
  });
});

class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Record<string, unknown>>();
    const query = req.query as Record<string, string>;
    if (query.role) {
      const user = { id: USER_ID, role: query.role };
      req.user = user;
      req.principal = { kind: 'human', user };
    } else if (query.sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: 'clsa0000000000000000001' },
        permissions: new Set(query.sa.split(',').filter(Boolean)),
      };
    }
    return true;
  }
}

const HEADER =
  'reference,supplier,status,receipt,orderDate,expectedDate,invoiceNumbers,invoiceDate,company,lineCount,unitsOrdered,unitsReceived,unitsPending,total,currency,unpricedLines,createdAt';

describe('GET /purchase-orders/export', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;

  beforeEach(async () => {
    prisma = makePrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [PurchaseOrdersController],
      providers: [
        Reflector,
        PermissionResolverService,
        ActorService,
        ExportService,
        ExportLimiter,
        PurchaseOrdersService,
        { provide: PrismaService, useValue: prisma },
        { provide: PurchaseReceivingService, useValue: {} },
        { provide: PurchaseLicenseService, useValue: {} },
        { provide: PurchaseFromAssetsService, useValue: {} },
        { provide: PurchaseExtractionService, useValue: {} },
        { provide: APP_GUARD, useClass: FakeAuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('streams one row per purchase under the pinned header, money from minor units, with one audit row', async () => {
    const rows = [
      purchaseRow({
        lines: [
          lineRow({ quantity: 2, unitPrice: 123456n }),
          lineRow({
            id: 'clline000000000000000002',
            kind: 'OTHER',
            description: 'Shipping',
            unitPrice: null,
          }),
        ],
      }),
      purchaseRow({
        id: 'clpo00000000000000000002',
        reference: '+SUM(A1)',
        supplier: null,
        status: 'DRAFT',
        currency: null,
        orderDate: null,
        company: null,
        invoiceNumbers: null,
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        lines: [lineRow({ id: 'clline000000000000000003', unitPrice: 10000n })],
      }),
      purchaseRow({
        id: 'clpo00000000000000000003',
        reference: null,
        createdAt: new Date('2026-09-30T10:00:00.000Z'),
      }),
    ];
    prisma.purchaseOrder.count.mockResolvedValue(rows.length);
    prisma.purchaseOrder.findMany.mockResolvedValue(rows);
    prisma.asset.groupBy.mockResolvedValue([
      { purchaseOrderLineId: 'clline000000000000000001', _count: { _all: 2 } },
    ]);

    const res = await http()
      .get('/purchase-orders/export?role=MEMBER&status=ORDERED,DRAFT')
      .expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-purchases-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(res.text).toBe(
      '﻿' +
        [
          HEADER,
          'OC-1,Compumundo,ORDERED,RECEIVED,2026-10-01T00:00:00.000Z,,"F-1, F-2",,Acme,2,2,2,0,2469.12,USD,1,2026-10-02T10:00:00.000Z',
          "'+SUM(A1),,DRAFT,NONE,,,,,,1,1,0,1,100,,0,2026-10-01T10:00:00.000Z",
          ',Compumundo,ORDERED,,2026-10-01T00:00:00.000Z,,"F-1, F-2",,Acme,0,,,,,USD,0,2026-09-30T10:00:00.000Z',
        ].join('\r\n') +
        '\r\n',
    );
    expect(res.text).not.toContain('never exported');
    expect(prisma.dataExportLog.create).toHaveBeenCalledWith({
      data: {
        actorId: USER_ID,
        serviceAccountId: null,
        resource: 'PURCHASE_ORDERS',
        filters: { status: ['ORDERED', 'DRAFT'], deleted: 'active' },
        rowCount: 3,
      },
    });
  });

  it('403 for a VIEWER (purchaseOrder:read is denied by default), before any read', async () => {
    await http().get('/purchase-orders/export?role=VIEWER').expect(403);
    expect(prisma.purchaseOrder.count).not.toHaveBeenCalled();
    expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
  });

  it('403 for a MEMBER on deleted=only; an ADMIN exports the archived slice', async () => {
    await http()
      .get('/purchase-orders/export?role=MEMBER&deleted=only')
      .expect(403);
    expect(prisma.purchaseOrder.count).not.toHaveBeenCalled();

    await http()
      .get('/purchase-orders/export?role=ADMIN&deleted=only')
      .expect(200);
    const [args] = prisma.purchaseOrder.count.mock.calls[0] as [Row];
    expect(args).toEqual({
      where: { AND: [{ AND: [] }, { deletedAt: { not: null } }] },
      includeSoftDeleted: true,
    });
  });

  it('a service account needs purchaseOrder:read', async () => {
    await http().get('/purchase-orders/export?sa=asset:read').expect(403);
    await http()
      .get('/purchase-orders/export?sa=purchaseOrder:read')
      .expect(200);
  });

  it('400 on a bad status, receipt or supplierId, like the list', async () => {
    await http()
      .get('/purchase-orders/export?role=ADMIN&status=LOST')
      .expect(400);
    await http()
      .get('/purchase-orders/export?role=ADMIN&receipt=SOME')
      .expect(400);
    await http()
      .get('/purchase-orders/export?role=ADMIN&supplierId=nope')
      .expect(400);
  });

  describe('format=xlsx (ADR-0103 §11)', () => {
    const binary = (path: string) =>
      http()
        .get(path)
        .buffer(true)
        .parse((res, done) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
          res.on('end', () => done(null, Buffer.concat(chunks)));
        });

    it('one sheet with the CSV header, typed cells, money in major units beside its currency, one audit row', async () => {
      const rows = [
        purchaseRow({
          lines: [lineRow({ quantity: 2, unitPrice: 123456n })],
        }),
        purchaseRow({
          id: 'clpo00000000000000000002',
          reference: '+SUM(A1)',
          supplier: null,
          status: 'DRAFT',
          currency: null,
          orderDate: null,
          createdAt: new Date('2026-10-01T10:00:00.000Z'),
          lines: [],
        }),
      ];
      prisma.purchaseOrder.count.mockResolvedValue(rows.length);
      prisma.purchaseOrder.findMany.mockResolvedValue(rows);
      prisma.asset.groupBy.mockResolvedValue([
        {
          purchaseOrderLineId: 'clline000000000000000001',
          _count: { _all: 1 },
        },
      ]);

      const res = await binary(
        '/purchase-orders/export?role=MEMBER&status=ORDERED,DRAFT&format=xlsx',
      ).expect(200);

      expect(res.headers['content-type']).toBe(XLSX_CONTENT_TYPE);
      expect(res.headers['content-disposition']).toMatch(
        /^attachment; filename="lazyit-purchases-\d{4}-\d{2}-\d{2}\.xlsx"$/,
      );
      const read = await readXlsx(res.body as Buffer);
      expect(read.parts['xl/workbook.xml']).toContain(
        '<sheet name="purchases"',
      );
      expect(
        [...read.rows.get(1)!.values()].map((c) => c.value).join(','),
      ).toBe(HEADER);
      const [first, second] = xlsxRecords(read);
      expect(first.reference).toMatchObject({
        type: 'inlineStr',
        value: 'OC-1',
      });
      expect(first.orderDate).toMatchObject({
        type: 'n',
        style: XLSX_STYLE.date,
        value: '46296',
      });
      expect(first.lineCount).toMatchObject({ type: 'n', value: '1' });
      expect(first.unitsPending).toMatchObject({ type: 'n', value: '1' });
      // 2 × 1234.56: the total is a number in major units, its currency in the next column.
      expect(first.total).toEqual({
        ref: 'N2',
        style: XLSX_STYLE.money,
        type: 'n',
        value: '2469.12',
      });
      expect(first.currency).toMatchObject({ ref: 'O2', value: 'USD' });
      expect(first.createdAt).toMatchObject({
        style: XLSX_STYLE.dateTime,
        value: '46297.41666666667',
      });
      // Text is never a formula and needs no quote guard.
      expect(second.reference).toMatchObject({
        type: 'inlineStr',
        value: '+SUM(A1)',
      });
      expect(second.supplier).toBeUndefined();
      expect(read.parts['xl/worksheets/sheet1.xml']).not.toContain(
        'never exported',
      );

      expect(prisma.dataExportLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.dataExportLog.create).toHaveBeenCalledWith({
        data: {
          actorId: USER_ID,
          serviceAccountId: null,
          resource: 'PURCHASE_ORDERS',
          filters: {
            status: ['ORDERED', 'DRAFT'],
            deleted: 'active',
            format: 'xlsx',
          },
          rowCount: 2,
        },
      });
    });

    it('keeps the permission and the soft-delete gate', async () => {
      await http()
        .get('/purchase-orders/export?role=VIEWER&format=xlsx')
        .expect(403);
      await http()
        .get('/purchase-orders/export?role=MEMBER&deleted=only&format=xlsx')
        .expect(403);
      expect(prisma.purchaseOrder.count).not.toHaveBeenCalled();
      expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
    });

    it('400 on an unknown format, before any read or audit row', async () => {
      await http()
        .get('/purchase-orders/export?role=ADMIN&format=ods')
        .expect(400);
      expect(prisma.purchaseOrder.count).not.toHaveBeenCalled();
      expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
    });
  });
});
