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
import { SearchService } from '../search/search.service';
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
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

let seq = 0;
function location(over: Record<string, unknown>) {
  seq += 1;
  return {
    id: `clloc${String(seq).padStart(19, '0')}`,
    name: `Place ${seq}`,
    type: 'OFFICE',
    description: null,
    address: null,
    floor: null,
    notes: null,
    parentId: null as string | null,
    // Pairs share a createdAt; the batch-of-2 walk below splits one across a batch boundary.
    createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(seq / 2))),
    updatedAt: new Date(Date.UTC(2026, 1, 1)),
    deletedAt: null as Date | null,
    ...over,
  };
}

const HQ = location({
  name: 'HQ',
  address: 'Av. Corrientes 1234',
  floor: 'PB',
});
const LOCATIONS = [
  HQ,
  location({ name: 'Server room', type: 'DATACENTER', parentId: HQ.id }),
  location({ name: 'Rack A', type: 'RACK', notes: '+cmd', parentId: HQ.id }),
  location({
    name: 'Old annex',
    deletedAt: new Date(Date.UTC(2026, 5, 1)),
  }),
  location({ name: 'Home office', type: 'REMOTE', description: 'hq overflow' }),
  location({
    name: 'Old rack',
    type: 'RACK',
    deletedAt: new Date(Date.UTC(2026, 6, 1)),
  }),
];

let caller = 0;
@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: unknown;
      principal?: unknown;
    }>();
    // A fresh caller per request keeps the per-principal export limiter out of the way.
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
    const user = { id: `caller-${caller}`, role: req.headers['x-test-role'] };
    req.user = user;
    req.principal = { kind: 'human', user };
    return true;
  }
}

describe('GET /locations/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const locationDelegate = inMemoryDelegate(LOCATIONS, { softDelete: true });
  const prisma = {
    location: locationDelegate,
    rolePermission: {
      findMany: jest.fn(({ where }: { where: { role: Role } }) =>
        Promise.resolve(
          DEFAULT_ROLE_PERMISSIONS[where.role].map((permission) => ({
            permission,
          })),
        ),
      ),
    },
    dataExportLog: { create: auditCreate },
    $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LocationsController],
      providers: [
        Reflector,
        LocationsService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: {} },
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

  beforeEach(() => {
    auditCreate.mockClear();
    locationDelegate.count.mockClear();
  });

  const http = () => request(app.getHttpServer());

  async function listIds(role: Role, query: string): Promise<string[]> {
    const res = await http()
      .get(`/locations?limit=200&${query}`)
      .set('X-Test-Role', role);
    expect(res.status).toBe(200);
    return (res.body as { items: { id: string }[] }).items.map((l) => l.id);
  }

  const exportAs = (role: Role, query: string) =>
    http().get(`/locations/export?${query}`).set('X-Test-Role', role);

  it('pins the header: the list row, with parentId and no resolved path', async () => {
    const res = await exportAs('VIEWER', '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-locations-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csvHeader(res.text)).toBe(
      'id,name,type,parentId,address,floor,description,notes,createdAt,updatedAt,deletedAt',
    );
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'q=hq'],
    ['ADMIN', 'type=RACK'],
    ['ADMIN', 'type=RACK&q=rack'],
    ['ADMIN', 'deleted=only'],
    ['ADMIN', 'deleted=only&type=RACK'],
    ['MEMBER', 'type=DATACENTER'],
    ['VIEWER', 'q=o'],
  ] as const)(
    '%s with "%s": the export holds exactly the ids the list returns',
    async (role, query) => {
      const listed = await listIds(role, query);
      expect(listed.length).toBeGreaterThan(0);
      const res = await exportAs(role, query);
      expect(res.status).toBe(200);
      const exported = csvRows(res.text).map((cells) => cells[0]);
      expect(new Set(exported)).toEqual(new Set(listed));
      expect(exported).toHaveLength(listed.length);
    },
  );

  it('renders the hierarchy by id and guards a formula-looking note', async () => {
    const res = await exportAs('ADMIN', 'type=RACK');
    expect(csvRows(res.text)).toEqual([
      [
        LOCATIONS[2].id,
        'Rack A',
        'RACK',
        HQ.id,
        '',
        '',
        '',
        "'+cmd",
        LOCATIONS[2].createdAt.toISOString(),
        LOCATIONS[2].updatedAt.toISOString(),
        '',
      ],
    ]);
  });

  it('400 on an unknown type or deleted value, like the list', async () => {
    expect((await exportAs('ADMIN', 'type=CASTLE')).status).toBe(400);
    expect((await exportAs('ADMIN', 'deleted=all')).status).toBe(400);
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('403 for a non-admin on deleted=only, like the list, before any read or audit row', async () => {
    expect((await exportAs('MEMBER', 'deleted=only')).status).toBe(403);
    expect((await exportAs('VIEWER', 'deleted=only')).status).toBe(403);
    expect(locationDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('403 for a caller without location:read, like the list', async () => {
    const as = (path: string, sa: string) =>
      http().get(path).set('X-Test-Sa', sa);
    expect((await as('/locations/export', 'asset:read')).status).toBe(403);
    expect((await as('/locations', 'asset:read')).status).toBe(403);
    expect(locationDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect((await as('/locations/export', 'location:read')).status).toBe(200);
  });

  it('audits the export as LOCATIONS with its filters and the pre-count', async () => {
    await exportAs('MEMBER', 'type=RACK');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'LOCATIONS',
        filters: { type: 'RACK', deleted: 'active' },
        rowCount: 1,
      }) as unknown,
    });
  });

  it.each([['active'], ['only']] as const)(
    'exportSource(deleted=%s) walked in batches of 2 sends every matching location once',
    async (deleted) => {
      const source = app.get(LocationsService).exportSource({}, deleted);
      const batches: { id: string; createdAt: Date }[][] = [];
      for await (const batch of keysetBatches(source.fetchBatch, 2)) {
        batches.push(batch);
      }
      const sent = batches.flat().map((l) => l.id);
      const expected = LOCATIONS.filter((l) =>
        deleted === 'only' ? l.deletedAt !== null : l.deletedAt === null,
      ).map((l) => l.id);
      expect(sent).toHaveLength(new Set(sent).size);
      expect(new Set(sent)).toEqual(new Set(expected));
      expect(await source.count()).toBe(expected.length);
      if (deleted === 'active') {
        expect(batches.length).toBeGreaterThan(1);
        expect(splitsATie(batches)).toBe(true);
      }
    },
  );
});
