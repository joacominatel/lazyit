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
import { AccessGrantsService } from '../access-grants/access-grants.service';
import { AccessGrantsExportService } from '../access-grants/access-grants-export.service';
import { ArticlesService } from '../articles/articles.service';
import { ApplicationsController } from './applications.controller';
import { ApplicationsService } from './applications.service';

let seq = 0;
function application(over: Record<string, unknown>) {
  seq += 1;
  return {
    id: `clapp${String(seq).padStart(19, '0')}`,
    name: `App ${seq}`,
    description: null,
    url: null,
    vendor: null,
    categoryId: null,
    isCritical: false,
    metadata: { secretish: 'never exported' },
    notes: null,
    seatsPurchased: null,
    costPerSeat: null as bigint | null,
    renewalDate: null,
    // Pairs share a createdAt; the batch-of-2 walk below splits one across a batch boundary.
    createdAt: new Date(Date.UTC(2026, 0, 1 + Math.floor(seq / 2))),
    updatedAt: new Date(Date.UTC(2026, 1, 1)),
    deletedAt: null as Date | null,
    ...over,
  };
}

const APPS = [
  application({
    name: 'Slack',
    vendor: 'Salesforce',
    url: 'https://slack.com',
    isCritical: true,
    seatsPurchased: 20,
    costPerSeat: 1250n,
    renewalDate: new Date(Date.UTC(2027, 0, 1)),
  }),
  application({ name: 'Jira', vendor: 'Atlassian' }),
  application({ name: 'Confluence', vendor: 'Atlassian', notes: '=HYPERLINK' }),
  application({ name: 'Old CRM', deletedAt: new Date(Date.UTC(2026, 5, 1)) }),
  application({ name: 'VPN', description: 'slack-adjacent remote access' }),
  application({
    name: 'Legacy Wiki',
    vendor: 'Atlassian',
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

describe('GET /applications/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const applicationDelegate = inMemoryDelegate(APPS, { softDelete: true });
  const prisma = {
    application: applicationDelegate,
    // Two distinct users hold an active grant on Slack.
    accessGrant: {
      findMany: jest.fn(
        ({ where }: { where: { applicationId: { in: string[] } } }) =>
          Promise.resolve(
            where.applicationId.in.includes(APPS[0].id)
              ? [
                  { applicationId: APPS[0].id, userId: 'u1' },
                  { applicationId: APPS[0].id, userId: 'u2' },
                ]
              : [],
          ),
      ),
    },
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
      controllers: [ApplicationsController],
      providers: [
        Reflector,
        ApplicationsService,
        ExportService,
        ExportLimiter,
        ActorService,
        PermissionResolverService,
        { provide: PrismaService, useValue: prisma },
        { provide: SearchService, useValue: {} },
        { provide: AccessGrantsService, useValue: {} },
        { provide: AccessGrantsExportService, useValue: {} },
        { provide: ArticlesService, useValue: {} },
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
    applicationDelegate.count.mockClear();
    applicationDelegate.findMany.mockClear();
  });

  const http = () => request(app.getHttpServer());

  async function listIds(role: Role, query: string): Promise<string[]> {
    const res = await http()
      .get(`/applications?limit=200&${query}`)
      .set('X-Test-Role', role);
    expect(res.status).toBe(200);
    return (res.body as { items: { id: string }[] }).items.map((a) => a.id);
  }

  const exportAs = (role: Role, query: string) =>
    http().get(`/applications/export?${query}`).set('X-Test-Role', role);

  it('pins the header: the list projection only, never the metadata JSON', async () => {
    const res = await exportAs('VIEWER', '');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-applications-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(csvHeader(res.text)).toBe(
      'id,name,vendor,url,description,isCritical,seatsPurchased,seatsUsed,costPerSeat,renewalDate,notes,createdAt,updatedAt,deletedAt',
    );
    expect(res.text).not.toContain('never exported');
  });

  it.each([
    ['ADMIN', ''],
    ['ADMIN', 'q=atlassian'],
    ['ADMIN', 'q=slack'],
    ['ADMIN', 'deleted=only'],
    ['ADMIN', 'deleted=only&q=wiki'],
    ['MEMBER', 'q=atlassian'],
    ['VIEWER', ''],
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

  it('renders a row as the list does: money from minor units, derived seats, guarded text', async () => {
    const res = await exportAs('ADMIN', 'q=a');
    const byId = new Map(csvRows(res.text).map((cells) => [cells[0], cells]));
    expect(byId.get(APPS[0].id)).toEqual([
      APPS[0].id,
      'Slack',
      'Salesforce',
      'https://slack.com',
      '',
      'true',
      '20',
      '2',
      '12.50',
      '2027-01-01T00:00:00.000Z',
      '',
      APPS[0].createdAt.toISOString(),
      APPS[0].updatedAt.toISOString(),
      '',
    ]);
    expect(byId.get(APPS[2].id)?.[10]).toBe("'=HYPERLINK");
    expect(byId.get(APPS[1].id)?.[7]).toBe('0');
  });

  it('403 for a non-admin on deleted=only, like the list, before any read or audit row', async () => {
    expect((await exportAs('MEMBER', 'deleted=only')).status).toBe(403);
    expect((await exportAs('VIEWER', 'deleted=only')).status).toBe(403);
    expect(applicationDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('403 for a caller without application:read, like the list', async () => {
    const as = (path: string, sa: string) =>
      http().get(path).set('X-Test-Sa', sa);
    expect((await as('/applications/export', 'asset:read')).status).toBe(403);
    expect((await as('/applications', 'asset:read')).status).toBe(403);
    expect(applicationDelegate.count).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect((await as('/applications/export', 'application:read')).status).toBe(
      200,
    );
  });

  it('400 on a bad deleted value, like the list', async () => {
    expect((await exportAs('ADMIN', 'deleted=all')).status).toBe(400);
  });

  it('audits the export as APPLICATIONS with its filters and the pre-count', async () => {
    await exportAs('MEMBER', 'q=atlassian');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'APPLICATIONS',
        filters: { q: 'atlassian', deleted: 'active' },
        rowCount: 2,
      }) as unknown,
    });
  });

  it.each([['active'], ['only']] as const)(
    'exportSource(deleted=%s) walked in batches of 2 sends every matching application once',
    async (deleted) => {
      const source = app.get(ApplicationsService).exportSource({}, deleted);
      const batches: { id: string; createdAt: Date }[][] = [];
      for await (const batch of keysetBatches(source.fetchBatch, 2)) {
        batches.push(batch);
      }
      const sent = batches.flat().map((a) => a.id);
      const expected = APPS.filter((a) =>
        deleted === 'only' ? a.deletedAt !== null : a.deletedAt === null,
      ).map((a) => a.id);
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
