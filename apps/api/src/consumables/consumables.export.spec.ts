jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: {},
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
import { NotificationsService } from '../notifications/notifications.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ConsumablesController } from './consumables.controller';
import { ConsumablesService } from './consumables.service';

const MIN_STOCK_FIELD = { __fieldRef: 'minStock' };
const CATEGORY = 'clcategory00000000000001';
const USER_ID = '11111111-1111-4111-8111-111111111111';

type Row = Record<string, unknown>;

function consumableRow(over: Row = {}): Row {
  return {
    id: 'clconsumable000000000001',
    name: 'Toner',
    sku: 'TN-1',
    categoryId: CATEGORY,
    description: null,
    currentStock: 4,
    minStock: null,
    unit: 'units',
    notes: null,
    returnable: false,
    createdAt: new Date('2026-10-01T10:00:00.000Z'),
    updatedAt: new Date('2026-10-02T10:00:00.000Z'),
    deletedAt: null,
    category: { name: 'Printing', deletedAt: null },
    ...over,
  };
}

function makePrisma() {
  const prisma = {
    consumable: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      fields: { minStock: MIN_STOCK_FIELD },
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
    $transaction: jest.fn((queries: Promise<unknown>[]) =>
      Promise.all(queries),
    ),
  };
  return prisma;
}

type FakePrisma = ReturnType<typeof makePrisma>;

function serviceOver(prisma: FakePrisma): ConsumablesService {
  return new ConsumablesService(
    prisma as unknown as PrismaService,
    new ActorService(),
    {} as NotificationsService,
    {} as AssetHistoryService,
    {} as PermissionResolverService,
  );
}

describe('ConsumablesService.exportSource — the list rows (ADR-0103)', () => {
  const cases: [string, Parameters<ConsumablesService['findPage']>[0]][] = [
    ['no filter', {}],
    ['lowStock', { lowStock: true }],
    ['q + category', { q: 'ton', categoryId: CATEGORY }],
    ['every filter', { q: 'ton', categoryId: CATEGORY, lowStock: true }],
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

        const [listFind] = prisma.consumable.findMany.mock.calls[0] as [Row];
        const [listCount] = prisma.consumable.count.mock.calls[0] as [Row];
        const [exportCount] = prisma.consumable.count.mock.calls[1] as [Row];
        const [exportFind] = prisma.consumable.findMany.mock.calls[1] as [Row];
        expect(exportCount).toEqual(listCount);
        expect(exportFind.where).toEqual(listFind.where);
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

  it('lowStock is the same field comparison the list filters on', async () => {
    const prisma = makePrisma();
    await serviceOver(prisma)
      .exportSource({ lowStock: true }, 'active')
      .count();
    const [args] = prisma.consumable.count.mock.calls[0] as [
      { where: Row & { currentStock: { lte: unknown } } },
    ];
    expect(args.where.minStock).toEqual({ not: null });
    expect(args.where.currentStock.lte).toBe(MIN_STOCK_FIELD);
  });

  it('a later batch narrows the list where with the keyset cursor only', async () => {
    const prisma = makePrisma();
    const source = serviceOver(prisma).exportSource({ q: 'ton' }, 'active');
    const after = { createdAt: new Date('2026-10-01T10:00:00Z'), id: 'k9' };
    await source.fetchBatch(after, 1000);
    const [args] = prisma.consumable.findMany.mock.calls[0] as [Row];
    const listWhere = serviceOver(makePrisma()).listWhere(
      { q: 'ton' },
      'active',
    );
    expect(args.where).toEqual({
      AND: [
        listWhere,
        {
          OR: [
            { createdAt: { lt: after.createdAt } },
            { createdAt: after.createdAt, id: { lt: 'k9' } },
          ],
        },
      ],
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
  'name,sku,category,unit,currentStock,minStock,lowStock,createdAt,updatedAt';

describe('GET /consumables/export', () => {
  let app: INestApplication<App>;
  let prisma: FakePrisma;

  beforeEach(async () => {
    prisma = makePrisma();
    const moduleRef = await Test.createTestingModule({
      controllers: [ConsumablesController],
      providers: [
        Reflector,
        PermissionResolverService,
        ActorService,
        ExportService,
        ExportLimiter,
        ConsumablesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: {} },
        { provide: AssetHistoryService, useValue: {} },
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

  it('streams the pinned header and the rows, quantities raw, with one audit row', async () => {
    const rows = [
      consumableRow(),
      consumableRow({
        id: 'clconsumable000000000002',
        name: '=cmd',
        sku: null,
        currentStock: -3,
        minStock: 0,
        category: null,
        createdAt: new Date('2026-09-30T10:00:00.000Z'),
      }),
      consumableRow({
        id: 'clconsumable000000000003',
        name: 'Cable',
        currentStock: 0,
        minStock: 5,
        category: { name: 'Gone', deletedAt: new Date() },
        createdAt: new Date('2026-09-29T10:00:00.000Z'),
      }),
    ];
    prisma.consumable.count.mockResolvedValue(rows.length);
    prisma.consumable.findMany.mockResolvedValue(rows);

    const res = await http()
      .get('/consumables/export?role=VIEWER&lowStock=false&q=t')
      .expect(200);

    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.text).toBe(
      '﻿' +
        [
          HEADER,
          'Toner,TN-1,Printing,units,4,,false,2026-10-01T10:00:00.000Z,2026-10-02T10:00:00.000Z',
          "'=cmd,,,units,-3,0,true,2026-09-30T10:00:00.000Z,2026-10-02T10:00:00.000Z",
          'Cable,TN-1,,units,0,5,true,2026-09-29T10:00:00.000Z,2026-10-02T10:00:00.000Z',
        ].join('\r\n') +
        '\r\n',
    );
    expect(prisma.dataExportLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.dataExportLog.create).toHaveBeenCalledWith({
      data: {
        actorId: USER_ID,
        serviceAccountId: null,
        resource: 'CONSUMABLES',
        filters: { lowStock: false, q: 't', deleted: 'active' },
        rowCount: 3,
      },
    });
  });

  it('403 for a non-admin on deleted=only, before any read or audit row', async () => {
    await http()
      .get('/consumables/export?role=MEMBER&deleted=only')
      .expect(403);
    expect(prisma.consumable.count).not.toHaveBeenCalled();
    expect(prisma.dataExportLog.create).not.toHaveBeenCalled();
  });

  it('an ADMIN exports the archived slice', async () => {
    await http().get('/consumables/export?role=ADMIN&deleted=only').expect(200);
    const [args] = prisma.consumable.count.mock.calls[0] as [Row];
    expect(args).toEqual({
      where: { deletedAt: { not: null } },
      includeSoftDeleted: true,
    });
  });

  it('a service account needs consumable:read', async () => {
    await http().get('/consumables/export?sa=asset:read').expect(403);
    await http().get('/consumables/export?sa=consumable:read').expect(200);
  });

  it('400 on a malformed category or deleted value, like the list', async () => {
    await http()
      .get('/consumables/export?role=ADMIN&category=nope')
      .expect(400);
    await http().get('/consumables/export?role=ADMIN&deleted=all').expect(400);
  });

  it('is not captured by the :id route', async () => {
    await http().get('/consumables/export?role=VIEWER').expect(200);
    expect(prisma.consumable.count).toHaveBeenCalledTimes(1);
  });
});
