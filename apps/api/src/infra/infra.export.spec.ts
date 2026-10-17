jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class {},
  Prisma: { TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' } },
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
import { AssetsService } from '../assets/assets.service';
import { AssetHistoryService } from '../asset-history/asset-history.service';
import { AssetAssignmentsService } from '../asset-assignments/asset-assignments.service';
import { ArticlesService } from '../articles/articles.service';
import { SecretManagerService } from '../secret-manager/secret-manager.service';
import { SearchService } from '../search/search.service';
import { NotificationsService } from '../notifications/notifications.service';
import { InfraController } from './infra.controller';
import { InfraService } from './infra.service';
import { InfraAutoConfirmService } from './infra-auto-confirm.service';
import { InfraNodeEnrollmentLimiter } from './infra-node-enrollment.limiter';
import { AgentPolicyService } from './agent-policy.service';
import { AgentFleetService } from './agent-fleet.service';

const ASSET1 = 'classet00000000000000001';
const ASSET2 = 'classet00000000000000002';
const SPECS_MARKER = 'installed-software-blob';
const MACHINE_ID = 'machine-id-0f3a';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');

let seq = 0;
function node(day: number, over: Record<string, unknown> = {}) {
  seq += 1;
  return {
    id: `clnode${String(seq).padStart(18, '0')}`,
    kind: 'PHYSICAL_HOST',
    label: `host-${seq}`,
    status: 'ONLINE',
    assetId: null,
    ipAddress: `10.0.0.${seq}`,
    ipAddressSource: 'MANUAL',
    shortcuts: [],
    x: 0,
    y: 0,
    source: 'MANUAL',
    state: 'CONFIRMED',
    reportingSource: null,
    externalId: null,
    lastReportedAt: null,
    agentVersion: null,
    chassis: null,
    specs: { software: [SPECS_MARKER] },
    createdAt: new Date(T0 + day * DAY),
    updatedAt: new Date(T0 + day * DAY),
    deletedAt: null,
    asset: null,
    ...over,
  };
}

const owner = (firstName: string, lastName: string) => ({
  id: `as-${firstName}`,
  user: {
    id: `00000000-0000-4000-8000-00000000000${firstName.length}`,
    firstName,
    lastName,
    email: `${firstName.toLowerCase()}@lazyit.local`,
    deletedAt: null,
  },
});

const NODES = [
  node(1, {
    assetId: ASSET1,
    asset: {
      name: 'Rack server',
      deletedAt: null,
      assignments: [owner('Ana', 'Diaz'), owner('Bruno', 'Ruiz')],
    },
  }),
  node(2, {
    source: 'AGENT',
    reportingSource: 'agent',
    externalId: MACHINE_ID,
    agentVersion: '2.1.0',
    lastReportedAt: new Date(T0 + 2 * DAY),
    chassis: 'rack',
  }),
  // Same createdAt as the next node: the batch-of-2 walk splits the tie.
  node(3, {
    source: 'AGENT',
    state: 'PENDING',
    externalId: `${MACHINE_ID}/container/abc`,
    kind: 'CONTAINER',
  }),
  node(3, {
    status: 'OFFLINE',
    assetId: ASSET2,
    asset: { name: 'Archived box', deletedAt: new Date(T0), assignments: [] },
  }),
  node(4, { kind: 'VM', label: '=cmd' }),
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

const HEADER =
  'Label,Kind,Status,State,Source,IP address,Chassis,Asset,Owners,Agent version,Last reported at,' +
  'Created at,Updated at,Asset ID,Node ID';

describe('GET /infra/nodes/export (ADR-0103)', () => {
  let app: INestApplication<App>;
  const auditCreate = jest.fn().mockResolvedValue({});
  const infraNode = inMemoryDelegate(NODES);
  const prisma = {
    infraNode,
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
      controllers: [InfraController],
      providers: [
        Reflector,
        PermissionResolverService,
        ActorService,
        ExportService,
        ExportLimiter,
        InfraService,
        { provide: PrismaService, useValue: prisma },
        ...[
          AssetsService,
          AssetHistoryService,
          AssetAssignmentsService,
          ArticlesService,
          SecretManagerService,
          SearchService,
          InfraNodeEnrollmentLimiter,
          NotificationsService,
          InfraAutoConfirmService,
          AgentPolicyService,
          AgentFleetService,
        ].map((provide) => ({ provide, useValue: {} })),
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

  const exportedIds = (text: string) =>
    csvRows(text).map((cells) => cells[cells.length - 1]);

  it('pins the header and never writes specs, agent identity keys or an archived asset', async () => {
    const res = await get('/infra/nodes/export', 'VIEWER');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(csvHeader(res.text)).toBe(HEADER);
    expect(res.text).not.toContain(SPECS_MARKER);
    expect(res.text).not.toContain(MACHINE_ID);
    expect(res.text).not.toContain('Archived box');
    const byId = new Map(csvRows(res.text).map((c) => [c[14], c]));
    expect(byId.get(NODES[0].id)!.slice(7, 9)).toEqual([
      'Rack server',
      'Ana Diaz; Bruno Ruiz',
    ]);
    expect(byId.get(NODES[1].id)!.slice(4, 11)).toEqual([
      'AGENT',
      '10.0.0.2',
      'rack',
      '',
      '',
      '2.1.0',
      '2026-10-03T00:00:00.000Z',
    ]);
    expect(byId.get(NODES[3].id)!.slice(7, 9)).toEqual(['', '']);
    expect(byId.get(NODES[4].id)![0]).toBe("'=cmd");
  });

  it.each([
    [''],
    ['kind=PHYSICAL_HOST'],
    ['status=OFFLINE'],
    ['state=PENDING'],
    ['source=AGENT'],
    ['role=HOST'],
    ['role=CHILD'],
    [`assetIds=${ASSET1},${ASSET2}`],
    [`ids=${NODES[0].id},${NODES[4].id}`],
    ['source=AGENT&state=CONFIRMED'],
  ])('with "%s" holds exactly the ids the page returns', async (query) => {
    const list = await get(`/infra/nodes/page?limit=200&${query}`, 'VIEWER');
    expect(list.status).toBe(200);
    const listed = (list.body as { items: { id: string }[] }).items.map(
      (n) => n.id,
    );
    expect(listed.length).toBeGreaterThan(0);
    const res = await get(`/infra/nodes/export?${query}`, 'VIEWER');
    expect(res.status).toBe(200);
    const exported = exportedIds(res.text);
    expect(new Set(exported)).toEqual(new Set(listed));
    expect(exported).toHaveLength(listed.length);
  });

  it('a q search reads the same where as the page', async () => {
    infraNode.findMany.mockClear();
    infraNode.count.mockClear();
    infraNode.findMany.mockResolvedValueOnce([]);
    infraNode.count.mockResolvedValueOnce(0);
    await get('/infra/nodes/page?q=ana', 'VIEWER');
    infraNode.findMany.mockResolvedValueOnce([]);
    infraNode.count.mockResolvedValueOnce(0);
    await get('/infra/nodes/export?q=ana', 'VIEWER');
    const [pageArgs] = infraNode.findMany.mock.calls[0] as [
      { where?: unknown },
    ];
    const [exportCount] = infraNode.count.mock.calls[1] as [
      { where?: unknown },
    ];
    const [exportFind] = infraNode.findMany.mock.calls[1] as [
      { where?: unknown },
    ];
    expect(exportCount.where).toEqual(pageArgs.where);
    expect(exportFind.where).toEqual(pageArgs.where);
    expect(pageArgs.where).toHaveProperty('OR');
  });

  it('rejects paging, sort and unknown keys, and malformed filters, before any audit row', async () => {
    for (const query of [
      'limit=10',
      'sort=label',
      'deleted=only',
      'kind=PRINTER',
      'ids=nope',
    ]) {
      const res = await get(`/infra/nodes/export?${query}`, 'ADMIN');
      expect(res.status).toBe(400);
    }
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('a service account needs infra:read', async () => {
    const as = (permissions: string) =>
      request(app.getHttpServer())
        .get('/infra/nodes/export')
        .set('X-Test-Sa-Permissions', permissions);
    expect((await as('asset:read')).status).toBe(403);
    expect((await as('infra:read')).status).toBe(200);
  });

  it('is not captured by the nodes/:id route', async () => {
    const res = await get('/infra/nodes/export', 'ADMIN');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="lazyit-servers-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
  });

  it('audits each export as INFRA_NODES with its filters', async () => {
    await get('/infra/nodes/export?source=AGENT&role=HOST', 'ADMIN');
    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resource: 'INFRA_NODES',
        filters: { source: 'AGENT', role: 'HOST' },
        rowCount: 1,
      }) as unknown,
    });
  });

  it('nodeExportSource walked in batches of 2 sends every node once', async () => {
    const source = app.get(InfraService).nodeExportSource({});
    const batches: { id: string; createdAt: Date }[][] = [];
    for await (const batch of keysetBatches(source.fetchBatch, 2)) {
      batches.push(batch);
    }
    const sent = batches.flat().map((n) => n.id);
    expect(sent).toHaveLength(new Set(sent).size);
    expect(new Set(sent)).toEqual(new Set(NODES.map((n) => n.id)));
    expect(splitsATie(batches)).toBe(true);
  });
});
