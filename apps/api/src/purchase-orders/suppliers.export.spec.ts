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
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';

let seq = 0;
function supplier(over: Record<string, unknown>) {
  seq += 1;
  return {
    id: `clsup${String(seq).padStart(19, '0')}`,
    name: `Supplier ${seq}`,
    taxId: null,
    website: null,
    salesContactName: null,
    salesContactEmail: null,
    salesContactPhone: null,
    supportContactName: null,
    supportContactEmail: null,
    supportContactPhone: null,
    notes: null,
    // Pairs share a createdAt; the batch-of-2 walk below splits one across a batch boundary.
    createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(seq / 2))),
    updatedAt: new Date(Date.UTC(2026, 1, 1)),
    deletedAt: null as Date | null,
    ...over,
  };
}

const SUPPLIERS = [
  supplier({
    name: 'Compumundo',
    taxId: '30-12345678-9',
    website: 'https://compumundo.example',
    salesContactName: 'Ana Ventas',
    salesContactEmail: 'ventas@compumundo.example',
    salesContactPhone: '+54 11 5555-0000',
    supportContactName: 'Soporte',
    supportContactEmail: 'rma@compumundo.example',
    supportContactPhone: '0800-RMA',
  }),
  supplier({ name: 'Dell Argentina', salesContactName: 'Bruno' }),
  supplier({ name: 'Mercado', notes: 'pays by transfer' }),
  supplier({
    name: 'Old distributor',
    deletedAt: new Date(Date.UTC(2026, 5, 1)),
  }),
  supplier({ name: 'Tienda', supportContactEmail: 'help@dell.example' }),
  supplier({
    name: 'Defunct Dell reseller',
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

describe('GET /suppliers/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const supplierDelegate = inMemoryDelegate(SUPPLIERS, { softDelete: true });
  const prisma = {
    supplier: supplierDelegate,
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
      controllers: [SuppliersController],
      providers: [
        Reflector,
        SuppliersService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
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
    supplierDelegate.count.mockClear();
  });

  const http = () => request(app.getHttpServer());

  async function listIds(role: Role, query: string): Promise<string[]> {
    const res = await http()
      .get(`/suppliers?limit=200&${query}`)
      .set('X-Test-Role', role);
    expect(res.status).toBe(200);
    return (res.body as { items: { id: string }[] }).items.map((s) => s.id);
  }

  const exportAs = (role: Role, query: string) =>
    http().get(`/suppliers/export?${query}`).set('X-Test-Role', role);

  it('pins the header: the list row, field for field', async () => {
    const res = await exportAs('MEMBER', '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-suppliers-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csvHeader(res.text)).toBe(
      'id,name,taxId,website,salesContactName,salesContactEmail,salesContactPhone,' +
        'supportContactName,supportContactEmail,supportContactPhone,notes,createdAt,updatedAt,deletedAt',
    );
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'q=dell'],
    ['ADMIN', 'q=compumundo'],
    ['ADMIN', 'deleted=only'],
    ['ADMIN', 'deleted=only&q=dell'],
    ['MEMBER', ''],
    ['MEMBER', 'q=dell'],
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

  it('renders every contact field, and guards a phone that starts with +', async () => {
    const res = await exportAs('ADMIN', 'q=compumundo');
    expect(csvRows(res.text)).toEqual([
      [
        SUPPLIERS[0].id,
        'Compumundo',
        '30-12345678-9',
        'https://compumundo.example',
        'Ana Ventas',
        'ventas@compumundo.example',
        "'+54 11 5555-0000",
        'Soporte',
        'rma@compumundo.example',
        '0800-RMA',
        '',
        SUPPLIERS[0].createdAt.toISOString(),
        SUPPLIERS[0].updatedAt.toISOString(),
        '',
      ],
    ]);
  });

  it('403 for a VIEWER (purchaseOrder:read is denied by default), like the list, before any read', async () => {
    expect((await exportAs('VIEWER', '')).status).toBe(403);
    expect(
      (await http().get('/suppliers').set('X-Test-Role', 'VIEWER')).status,
    ).toBe(403);
    expect(supplierDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('403 for a MEMBER on deleted=only, like the list, before any read or audit row', async () => {
    expect((await exportAs('MEMBER', 'deleted=only')).status).toBe(403);
    expect(supplierDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('a service account needs purchaseOrder:read', async () => {
    const as = (sa: string) =>
      http().get('/suppliers/export').set('X-Test-Sa', sa);
    expect((await as('asset:read')).status).toBe(403);
    expect((await as('purchaseOrder:read')).status).toBe(200);
  });

  it('400 on a bad deleted value, like the list', async () => {
    expect((await exportAs('ADMIN', 'deleted=all')).status).toBe(400);
  });

  it('audits the export as SUPPLIERS with its filters and the pre-count', async () => {
    await exportAs('MEMBER', 'q=dell');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'SUPPLIERS',
        filters: { q: 'dell', deleted: 'active' },
        rowCount: 2,
      }) as unknown,
    });
  });

  it.each([['active'], ['only']] as const)(
    'exportSource(deleted=%s) walked in batches of 2 sends every matching supplier once',
    async (deleted) => {
      const source = app.get(SuppliersService).exportSource({}, deleted);
      const batches: { id: string; createdAt: Date }[][] = [];
      for await (const batch of keysetBatches(source.fetchBatch, 2)) {
        batches.push(batch);
      }
      const sent = batches.flat().map((s) => s.id);
      const expected = SUPPLIERS.filter((s) =>
        deleted === 'only' ? s.deletedAt !== null : s.deletedAt === null,
      ).map((s) => s.id);
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
