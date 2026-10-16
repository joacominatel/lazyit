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
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type Role,
} from '@lazyit/shared';
import { RolesGuard } from '../auth/roles.guard';
import { PermissionResolverService } from '../auth/permission-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { ActorService } from '../common/actor.service';
import { ExportService } from '../common/export';
import { ExportLimiter } from '../common/export/export-limiter';
import { keysetBatches } from '../common/export/keyset';
import {
  csvHeader,
  csvRows,
  inMemoryDelegate,
  splitsATie,
} from '../common/in-memory-where.harness-spec';
import { NotificationsService } from '../notifications/notifications.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { ConsumablesController } from './consumables.controller';
import { ConsumablesService } from './consumables.service';

const TONER = 'clconsumable000000000001';
const HEADSET = 'clconsumable000000000002';
const GONE = 'clconsumable000000000009';
const ANA = '11111111-1111-4111-8111-111111111111';
const LAPTOP = 'classet00000000000000001';
const DESK = 'cllocation00000000000001';

const CONSUMABLES = {
  [TONER]: { id: TONER, name: 'Toner', sku: 'TN-1', unit: 'units' },
  [HEADSET]: { id: HEADSET, name: 'Headset', sku: null, unit: 'pcs' },
};

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

type Movement = Record<string, unknown> & { id: number; createdAt: Date };

let nextId = 0;
function movement(
  consumableId: string,
  day: number,
  over: Record<string, unknown>,
): Movement {
  nextId += 1;
  return {
    id: nextId,
    consumableId,
    type: 'OUT',
    quantity: 1,
    reason: null,
    performedById: ANA,
    serviceAccountId: null,
    notes: null,
    targetUserId: null,
    targetAssetId: null,
    targetLocationId: null,
    returnable: false,
    returnOfId: null,
    purchaseOrderLineId: null,
    createdAt: new Date(T0 + day * DAY),
    consumable: {
      ...CONSUMABLES[consumableId as keyof typeof CONSUMABLES],
      deletedAt: consumableId === HEADSET ? new Date(T0) : null,
    },
    ...over,
  };
}

const MOVEMENTS: Movement[] = [
  movement(TONER, 1, { type: 'IN', quantity: 10, targetUserId: null }),
  movement(TONER, 2, { quantity: 2, targetUserId: ANA, returnable: true }),
  movement(TONER, 3, { targetAssetId: LAPTOP, reason: '=cmd' }),
  movement(TONER, 4, { type: 'IN', returnOfId: 2 }),
  // Same createdAt as the next row: the batch-of-2 walk splits the tie.
  movement(TONER, 5, { type: 'ADJUSTMENT', quantity: 7 }),
  movement(TONER, 5, { quantity: 3, targetLocationId: DESK }),
  movement(HEADSET, 6, { targetUserId: ANA, returnable: true }),
  movement(TONER, 7, { targetUserId: ANA }),
];

let caller = 0;
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    // A fresh caller per request keeps the per-principal export limiter out of the way.
    caller += 1;
    const sa = req.headers['x-test-sa-permissions'];
    if (sa !== undefined) {
      req.principal = {
        kind: 'service',
        serviceAccount: { id: `sa-${caller}` },
        permissions: new Set(sa.split(',') as Permission[]),
      };
      return true;
    }
    const u = { id: `caller-${caller}`, role: req.headers['x-test-role'] };
    req.user = u;
    req.principal = { kind: 'human', user: u };
    return true;
  }
}

const MOVEMENT_HEADER =
  'Date,Type,Quantity,Reason,Notes,Performed by,Target type,Target ID,Target,Target archived,' +
  'Returnable,Return of,Purchase line ID,Movement ID';
const DELIVERY_HEADER =
  'Delivered at,Consumable,SKU,Unit,Consumable archived,Quantity,Returnable,Returned,Outstanding,' +
  'Target type,Target ID,Target,Target archived,Reason,Notes,Performed by,Delivery ID';

describe('Consumable ledger CSV exports (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const movements = inMemoryDelegate(MOVEMENTS);
  const prisma = {
    consumable: {
      findFirst: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === GONE ? null : { id: where.id }),
      ),
    },
    consumableMovement: movements,
    user: inMemoryDelegate([
      { id: ANA, firstName: 'Ana', lastName: 'Diaz', deletedAt: null },
    ]),
    asset: inMemoryDelegate([
      {
        id: LAPTOP,
        assetTag: 'LT-7',
        name: 'Laptop',
        serial: null,
        deletedAt: null,
      },
    ]),
    location: inMemoryDelegate([
      { id: DESK, name: 'Front desk', deletedAt: new Date(T0) },
    ]),
    // The outstanding read is raw SQL; the list and the export share it, so a fixed answer is enough.
    $queryRaw: jest.fn(() => Promise.resolve([{ id: 2 }, { id: 7 }])),
    dataExportLog: { create: auditCreate },
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

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => auditCreate.mockClear());

  const get = (path: string, role: Role) =>
    request(app.getHttpServer()).get(path).set('X-Test-Role', role);
  const asService = (path: string, permissions: string) =>
    request(app.getHttpServer())
      .get(path)
      .set('X-Test-Sa-Permissions', permissions);

  const lastCellIds = (text: string) =>
    csvRows(text).map((cells) => Number(cells[cells.length - 1]));

  describe('GET /consumables/:id/movements/export', () => {
    it('pins the header and writes quantities and ids as numbers', async () => {
      const res = await get(`/consumables/${TONER}/movements/export`, 'ADMIN');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(csvHeader(res.text)).toBe(MOVEMENT_HEADER);
      const adjustment = csvRows(res.text).find((c) => c[13] === '5')!;
      expect(adjustment.slice(1, 3)).toEqual(['ADJUSTMENT', '7']);
      const giveBack = csvRows(res.text).find((c) => c[13] === '4')!;
      expect(giveBack[11]).toBe('2');
      expect(res.text).toContain(",'=cmd,");
    });

    it.each([
      ['ADMIN', ''],
      ['ADMIN', 'type=OUT'],
      ['VIEWER', ''],
      ['VIEWER', 'type=IN'],
    ] as const)(
      'as %s with "%s" holds exactly the ids the list returns',
      async (role, query) => {
        const list = await get(
          `/consumables/${TONER}/movements?${query}`,
          role,
        );
        expect(list.status).toBe(200);
        const listed = (list.body as { id: number }[]).map((m) => m.id);
        expect(listed.length).toBeGreaterThan(0);
        const res = await get(
          `/consumables/${TONER}/movements/export?${query}`,
          role,
        );
        expect(res.status).toBe(200);
        const exported = lastCellIds(res.text);
        expect(new Set(exported)).toEqual(new Set(listed));
        expect(exported).toHaveLength(listed.length);
      },
    );

    it('a from/to range reads the same where as the list', async () => {
      const query = 'from=2026-10-02T00:00:00.000Z&to=2026-10-05T00:00:00.000Z';
      movements.count.mockClear();
      movements.findMany.mockClear();
      movements.findMany.mockResolvedValueOnce([]);
      await get(`/consumables/${TONER}/movements?${query}`, 'ADMIN');
      movements.findMany.mockResolvedValueOnce([]);
      movements.count.mockResolvedValueOnce(0);
      await get(`/consumables/${TONER}/movements/export?${query}`, 'ADMIN');
      const [listArgs] = movements.findMany.mock.calls[0] as [
        { where?: unknown },
      ];
      const [countArgs] = movements.count.mock.calls[0] as [
        { where?: unknown },
      ];
      expect(countArgs.where).toEqual(listArgs.where);
      expect(listArgs.where).toEqual({
        consumableId: TONER,
        createdAt: {
          gte: new Date('2026-10-02T00:00:00.000Z'),
          lte: new Date('2026-10-05T00:00:00.000Z'),
        },
      });
    });

    it('keeps a user target redacted for a caller without user:read, as the list does', async () => {
      const list = await get(`/consumables/${TONER}/movements`, 'VIEWER');
      const listedUserTarget = (
        list.body as { id: number; target: Record<string, unknown> | null }[]
      ).find((m) => m.id === 2)!.target;
      expect(listedUserTarget).toEqual({
        type: 'user',
        id: ANA,
        displayName: null,
        isOffboarded: null,
      });

      const res = await get(`/consumables/${TONER}/movements/export`, 'VIEWER');
      expect(res.text).not.toContain('Ana');
      expect(res.text).not.toContain('Diaz');
      const byId = new Map(csvRows(res.text).map((c) => [c[13], c]));
      expect(byId.get('2')!.slice(6, 10)).toEqual(['user', ANA, '', '']);
      // asset:read and location:read are VIEWER defaults: those targets resolve.
      expect(byId.get('3')!.slice(6, 10)).toEqual([
        'asset',
        LAPTOP,
        'LT-7',
        'false',
      ]);
      expect(byId.get('6')!.slice(6, 10)).toEqual([
        'location',
        DESK,
        'Front desk',
        'true',
      ]);
    });

    it('resolves the user target for a caller with user:read', async () => {
      const res = await get(`/consumables/${TONER}/movements/export`, 'MEMBER');
      const row = csvRows(res.text).find((c) => c[13] === '2')!;
      expect(row.slice(6, 10)).toEqual(['user', ANA, 'Ana Diaz', 'false']);
    });

    it('a service account with consumable:read alone sees every target redacted', async () => {
      const res = await asService(
        `/consumables/${TONER}/movements/export`,
        'consumable:read',
      );
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('LT-7');
      expect(res.text).not.toContain('Front desk');
      const row = csvRows(res.text).find((c) => c[13] === '3')!;
      expect(row.slice(6, 10)).toEqual(['asset', LAPTOP, '', '']);
    });

    it('404 on an unknown or archived consumable, before any audit row', async () => {
      const res = await get(`/consumables/${GONE}/movements/export`, 'ADMIN');
      expect(res.status).toBe(404);
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('400 on a malformed type, like the list', async () => {
      const res = await get(
        `/consumables/${TONER}/movements/export?type=LOST`,
        'ADMIN',
      );
      expect(res.status).toBe(400);
    });

    it('a service account without consumable:read is refused', async () => {
      const res = await asService(
        `/consumables/${TONER}/movements/export`,
        'asset:read',
      );
      expect(res.status).toBe(403);
    });

    it('audits the export as CONSUMABLE_MOVEMENTS with the consumable and filters', async () => {
      await get(`/consumables/${TONER}/movements/export?type=OUT`, 'ADMIN');
      expect(auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resource: 'CONSUMABLE_MOVEMENTS',
          filters: { consumableId: TONER, type: 'OUT' },
          rowCount: 4,
        }) as unknown,
      });
    });

    it('walks the ledger in batches of 2, every movement once', async () => {
      const source = await app
        .get(ConsumablesService)
        .movementsExportSource(TONER, {}, {
          kind: 'service',
          serviceAccount: { id: 'sa-walk' },
          permissions: new Set<Permission>(['consumable:read']),
        } as never);
      const batches: { id: number; createdAt: Date }[][] = [];
      for await (const batch of keysetBatches(source.fetchBatch, 2)) {
        batches.push(batch);
      }
      const sent = batches.flat().map((m) => m.id);
      const expected = MOVEMENTS.filter((m) => m.consumableId === TONER).map(
        (m) => m.id,
      );
      expect(sent).toHaveLength(new Set(sent).size);
      expect(new Set(sent)).toEqual(new Set(expected));
      expect(splitsATie(batches)).toBe(true);
    });
  });

  describe('GET /consumables/deliveries/export', () => {
    it('pins the header and carries the return state', async () => {
      const res = await get(
        `/consumables/deliveries/export?targetUserId=${ANA}`,
        'ADMIN',
      );
      expect(res.status).toBe(200);
      expect(csvHeader(res.text)).toBe(DELIVERY_HEADER);
      const byId = new Map(csvRows(res.text).map((c) => [c[16], c]));
      expect(byId.get('2')!.slice(1, 9)).toEqual([
        'Toner',
        'TN-1',
        'units',
        'false',
        '2',
        'true',
        '1',
        '1',
      ]);
      expect(byId.get('7')!.slice(1, 5)).toEqual([
        'Headset',
        '',
        'pcs',
        'true',
      ]);
      expect(byId.get('2')!.slice(9, 13)).toEqual([
        'user',
        ANA,
        'Ana Diaz',
        'false',
      ]);
    });

    it.each([
      ['ADMIN', `targetUserId=${ANA}`],
      ['ADMIN', `targetUserId=${ANA}&outstandingOnly=true`],
      ['VIEWER', `targetAssetId=${LAPTOP}`],
      ['MEMBER', `targetLocationId=${DESK}`],
    ] as const)(
      'as %s with "%s" holds exactly the ids the list returns',
      async (role, query) => {
        const list = await get(
          `/consumables/deliveries?limit=200&${query}`,
          role,
        );
        expect(list.status).toBe(200);
        const listed = (list.body as { items: { id: number }[] }).items.map(
          (d) => d.id,
        );
        expect(listed.length).toBeGreaterThan(0);
        const res = await get(`/consumables/deliveries/export?${query}`, role);
        expect(res.status).toBe(200);
        const exported = lastCellIds(res.text);
        expect(new Set(exported)).toEqual(new Set(listed));
        expect(exported).toHaveLength(listed.length);
      },
    );

    it('403 for a caller who cannot read the target kind, like the list, with no audit row', async () => {
      const path = `deliveries?targetUserId=${ANA}`;
      expect((await get(`/consumables/${path}`, 'VIEWER')).status).toBe(403);
      expect(
        (
          await get(
            `/consumables/deliveries/export?targetUserId=${ANA}`,
            'VIEWER',
          )
        ).status,
      ).toBe(403);
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('400 without exactly one target, like the list', async () => {
      expect(
        (await get('/consumables/deliveries/export', 'ADMIN')).status,
      ).toBe(400);
      expect(auditCreate).not.toHaveBeenCalled();
    });

    it('a service account needs consumable:read and the target kind read', async () => {
      const path = `/consumables/deliveries/export?targetLocationId=${DESK}`;
      expect((await asService(path, 'location:read')).status).toBe(403);
      expect((await asService(path, 'consumable:read')).status).toBe(403);
      expect(
        (await asService(path, 'consumable:read,location:read')).status,
      ).toBe(200);
    });

    it('audits the export as CONSUMABLE_DELIVERIES with its filters', async () => {
      await get(
        `/consumables/deliveries/export?targetAssetId=${LAPTOP}`,
        'ADMIN',
      );
      expect(auditCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          resource: 'CONSUMABLE_DELIVERIES',
          filters: { targetAssetId: LAPTOP, outstandingOnly: false },
          rowCount: 1,
        }) as unknown,
      });
    });
  });
});
