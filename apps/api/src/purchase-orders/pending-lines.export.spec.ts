jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {
    empty: { strings: [''], values: [] },
    join: (values: unknown[]) => values,
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
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
  Injectable,
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
import { csvHeader, csvRows } from '../common/in-memory-where.harness-spec';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetsService } from '../assets/assets.service';
import { ConsumablesService } from '../consumables/consumables.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  PurchaseReceivingService,
  type PendingLineFilters,
} from './purchase-receiving.service';
import { PurchaseLicenseService } from './purchase-license.service';
import { PurchaseFromAssetsService } from './purchase-from-assets.service';
import { PurchaseExtractionService } from './extraction/purchase-extraction.service';

const SUPPLIER = 'clsupplier00000000000001';
const LINE_A = 'clline00000000000000000a';
const LINE_B = 'clline00000000000000000b';
const PO = 'clpo00000000000000000001';

type Row = Record<string, unknown>;

function lineRow(over: Row = {}): Row {
  return {
    id: LINE_A,
    purchaseOrderId: PO,
    position: 0,
    kind: 'ASSET',
    description: 'Latitude 5450',
    manufacturerText: 'Dell',
    modelText: 'Latitude 5450',
    assetModelId: null,
    consumableId: null,
    applicationId: null,
    quantity: 5,
    unitPrice: 141250000n,
    cancelledQuantity: 1,
    warrantyMonths: 12,
    appliedSeats: 0,
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
    updatedAt: new Date('2026-10-02T10:00:00.000Z'),
    deletedAt: null,
    purchaseOrder: {
      id: PO,
      reference: 'OC-4512',
      status: 'ORDERED',
      currency: 'USD',
      orderDate: new Date('2026-10-01T00:00:00.000Z'),
      expectedDate: new Date('2026-10-20T00:00:00.000Z'),
      createdAt: new Date('2026-10-01T09:00:00.000Z'),
      supplier: { id: SUPPLIER, name: 'Compumundo', deletedAt: null },
    },
    ...over,
  };
}

const LINES = [
  lineRow(),
  lineRow({
    id: LINE_B,
    kind: 'CONSUMABLE',
    description: '=Toner',
    manufacturerText: null,
    modelText: null,
    quantity: 10,
    unitPrice: null,
    cancelledQuantity: 0,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    purchaseOrder: {
      ...(lineRow().purchaseOrder as Row),
      reference: null,
      expectedDate: null,
      supplier: null,
    },
  }),
];

/** A raw SQL id read answers `ids`; a COUNT answers `total`. Every call is kept for the assertions. */
function makePrisma(ids: string[] = [LINE_A, LINE_B]) {
  return {
    $queryRaw: jest.fn((strings: TemplateStringsArray) =>
      Promise.resolve(
        strings.join('?').includes('COUNT(*)')
          ? [{ total: ids.length }]
          : ids.map((id) => ({ id })),
      ),
    ),
    purchaseOrderLine: {
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        // Reversed: the SQL order is the one kept, never the findMany order.
        Promise.resolve(
          LINES.filter((l) => where.id.in.includes(l.id as string)).reverse(),
        ),
      ),
    },
    asset: {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { purchaseOrderLineId: LINE_A, _count: { _all: 3 } },
        ]),
    },
    consumableMovement: {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { purchaseOrderLineId: LINE_B, _sum: { quantity: 4 } },
        ]),
    },
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
  };
}

type FakePrisma = ReturnType<typeof makePrisma>;

function receivingOver(prisma: FakePrisma): PurchaseReceivingService {
  return new PurchaseReceivingService(
    prisma as unknown as PrismaService,
    new ActorService(),
    {} as AssetHistoryService,
    {} as AssetsService,
    new PurchaseOrdersService(
      prisma as unknown as PrismaService,
      new ActorService(),
    ),
    {} as ConsumablesService,
  );
}

/** The `[strings, ...values]` of the n-th raw query. */
function rawCall(prisma: FakePrisma, n: number): [string[], ...unknown[]] {
  const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as unknown as [
    TemplateStringsArray,
    ...unknown[],
  ];
  return [[...strings], ...values];
}

describe('PurchaseReceivingService.pendingLinesExportSource — the list rows (ADR-0103)', () => {
  const cases: [string, PendingLineFilters][] = [
    ['no filter', {}],
    ['supplier', { supplierId: SUPPLIER }],
  ];

  it.each(cases)(
    '%s: count and batches read the list filter fragment, and yield the list rows',
    async (_name, filters) => {
      const prisma = makePrisma();
      const service = receivingOver(prisma);

      const page = await service.findPendingLines(filters, {
        limit: 50,
        offset: 0,
        deleted: 'active',
      });
      const source = service.pendingLinesExportSource(filters);
      const total = await source.count();
      const batch = await source.fetchBatch(null, 1000);

      // Calls: list ids, list count, export count, export batch. The filter fragment is argument 1 of each.
      const [, listFilter] = rawCall(prisma, 0);
      const [, listCountFilter] = rawCall(prisma, 1);
      const [, exportCountFilter] = rawCall(prisma, 2);
      const [batchStrings, batchFilter, keyset, take] = rawCall(prisma, 3);
      expect(exportCountFilter).toEqual(listCountFilter);
      expect(batchFilter).toEqual(listFilter);
      const supplierClause = JSON.stringify(listFilter);
      if (filters.supplierId) {
        expect(supplierClause).toContain('po.\\"supplierId\\" = ');
        expect(supplierClause).toContain(SUPPLIER);
      } else {
        expect(supplierClause).not.toContain('supplierId');
      }
      expect(keyset).toEqual({ strings: [''], values: [] });
      expect(take).toBe(1000);
      expect(batchStrings.join('?')).toContain(
        'ORDER BY l."createdAt" DESC, l."id" DESC',
      );

      expect(total).toBe(page.total);
      expect(batch).toEqual(page.items);
      expect(batch.map((l) => l.id)).toEqual([LINE_A, LINE_B]);
      // A line archived between the id read and the hydration stays in an export batch.
      const [listHydration, exportHydration] = prisma.purchaseOrderLine.findMany
        .mock.calls as unknown as [Row][];
      expect(listHydration[0].includeSoftDeleted).toBeUndefined();
      expect(exportHydration[0].includeSoftDeleted).toBe(true);
    },
  );

  it('a later batch narrows the same fragment with the line keyset only', async () => {
    const prisma = makePrisma();
    const service = receivingOver(prisma);
    const filters = { supplierId: SUPPLIER };
    await service.findPendingLines(filters, {
      limit: 50,
      offset: 0,
      deleted: 'active',
    });
    const after = { createdAt: new Date('2026-10-01T10:00:00Z'), id: LINE_B };
    await service.pendingLinesExportSource(filters).fetchBatch(after, 1000);
    const [, listFilter] = rawCall(prisma, 0);
    const [, filter, keyset] = rawCall(prisma, 2);
    expect(filter).toEqual(listFilter);
    expect(keyset).toEqual({
      strings: ['AND (l."createdAt", l."id") < (', '::timestamp(3), ', ')'],
      values: [after.createdAt, LINE_B],
    });
  });
});

let caller = 0;
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    caller += 1;
    const sa = req.headers['x-test-sa'];
    if (sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: `clsa${String(caller).padStart(20, '0')}` },
        permissions: new Set(sa.split(',').filter(Boolean)),
      };
      return true;
    }
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      role: req.headers['x-test-role'],
    };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

const HEADER =
  'lineId,purchaseId,purchaseReference,supplier,purchaseStatus,orderDate,expectedDate,kind,description,' +
  'manufacturer,model,quantityOrdered,quantityCancelled,quantityReceived,quantityPending';

describe('GET /purchase-orders/pending-lines/export', () => {
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
        PurchaseReceivingService,
        { provide: PrismaService, useValue: prisma },
        { provide: AssetHistoryService, useValue: {} },
        { provide: AssetsService, useValue: {} },
        { provide: ConsumablesService, useValue: {} },
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

  it('streams one row per pending line under the pinned header, with one audit row', async () => {
    const res = await http()
      .get(`/purchase-orders/pending-lines/export?supplierId=${SUPPLIER}`)
      .set('X-Test-Role', 'MEMBER')
      .expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-pending-units-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csvHeader(res.text)).toBe(HEADER);
    expect(csvRows(res.text)).toEqual([
      [
        LINE_A,
        PO,
        'OC-4512',
        'Compumundo',
        'ORDERED',
        '2026-10-01T00:00:00.000Z',
        '2026-10-20T00:00:00.000Z',
        'ASSET',
        'Latitude 5450',
        'Dell',
        'Latitude 5450',
        '5',
        '1',
        '3',
        '1',
      ],
      [
        LINE_B,
        PO,
        '',
        '',
        'ORDERED',
        '2026-10-01T00:00:00.000Z',
        '',
        'CONSUMABLE',
        "'=Toner",
        '',
        '',
        '10',
        '0',
        '4',
        '6',
      ],
    ]);
    expect(res.text).not.toContain('1412500');
    expect(prisma.dataExportLog.create).toHaveBeenCalledWith({
      data: {
        actorId: '11111111-1111-4111-8111-111111111111',
        serviceAccountId: null,
        resource: 'PENDING_UNITS',
        filters: { supplierId: SUPPLIER },
        rowCount: 2,
      },
    });
  });

  it('403 for a VIEWER (purchaseOrder:read is denied by default), like the list, before any read', async () => {
    await http()
      .get('/purchase-orders/pending-lines/export')
      .set('X-Test-Role', 'VIEWER')
      .expect(403);
    await http()
      .get('/purchase-orders/pending-lines')
      .set('X-Test-Role', 'VIEWER')
      .expect(403);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
  });

  it('a service account needs purchaseOrder:read', async () => {
    await http()
      .get('/purchase-orders/pending-lines/export')
      .set('X-Test-Sa', 'asset:read')
      .expect(403);
    await http()
      .get('/purchase-orders/pending-lines/export')
      .set('X-Test-Sa', 'purchaseOrder:read')
      .expect(200);
  });

  it('400 on a malformed supplierId, like the list, before any read', async () => {
    await http()
      .get('/purchase-orders/pending-lines/export?supplierId=nope')
      .set('X-Test-Role', 'ADMIN')
      .expect(400);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
  });
});
